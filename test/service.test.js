// Scratch-service test: boots the real KinKeeper server on its own port with
// its own throwaway SQLite database (never the dev DB, never ports 8787/8788)
// and exercises the repaired behaviors end-to-end over HTTP + MCP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server.js';

const PORT = 8792;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `kinkeeper-scratch-test-${process.pid}.db`);

let server;

const post = (p, body) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const get = (p) => fetch(`${BASE}${p}`).then((r) => r.json());

before(async () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB + suffix); } catch {}
  }
  server = await startServer({ port: PORT, dbPath: DB, tickMs: 250 });
});

after(async () => {
  await server?.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB + suffix); } catch {}
  }
});

test('broad bind without a bearer token is refused at startup', async () => {
  await assert.rejects(
    () => startServer({ port: 8793, dbPath: path.join(os.tmpdir(), `kk-refused-${process.pid}.db`), host: '0.0.0.0' }),
    /Refusing to bind/
  );
});

test('negation-aware extraction through the live chat endpoint', async () => {
  const neg = await post('/api/chat', { senior_id: 'maggie', message: 'I had not taken my meds today.' });
  assert.equal(neg.facts.meds_taken, false);
  assert.equal(neg.facts.risk_flags.length, 0);

  const denied = await post('/api/chat', { senior_id: 'maggie', message: 'I did not fall and I have no chest pain.' });
  assert.deepEqual(denied.facts.risk_flags, []);
  assert.ok(denied.facts.negated_flags.includes('fall'));
  assert.ok(denied.facts.negated_flags.includes('pain'));
  assert.ok(denied.facts.negated_flags.includes('chest'));
});

test('regression: explicit "meds not taken" never yields a green "Today looks good" card', async () => {
  const res = await post('/api/chat', {
    senior_id: 'maggie',
    message: 'I had not taken my meds today, I forgot them.',
  });
  assert.equal(res.facts.meds_taken, false);

  const daily = res.cards.find((c) => c.kind === 'daily_status');
  assert.ok(daily, 'expected a daily status card');
  assert.notEqual(daily.severity, 'green');
  assert.equal(daily.severity, 'amber');
  assert.doesNotMatch(daily.title, /looks good/i);
  assert.match(daily.title, /needs a little attention/i);
  assert.ok(daily.lines.some((l) => /Medication: not taken/.test(l)));

  // The deterministic risk score reflects the self-report as a mild,
  // factual signal — but a missed-medication note alone never escalates.
  assert.equal(res.risk.escalate, false);
  assert.ok(res.risk.reasons.some((r) => /medication reported not taken/.test(r)));

  // Same guarantee at the MCP tool boundary (what any external client sees).
  const client = new Client({ name: 'meds-status-regression', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  await client.connect(transport);
  try {
    const rec = await client.callTool({
      name: 'record_checkin',
      arguments: {
        senior_id: 'maggie',
        transcript: 'No, I have not taken my pills yet today.',
        idempotency_key: 'scratch-meds-not-taken-1',
      },
    });
    assert.equal(rec.structuredContent.facts.meds_taken, false);
    assert.equal(rec.structuredContent.status, 'attention');
    assert.notEqual(rec.structuredContent.card.severity, 'green');
    assert.doesNotMatch(rec.structuredContent.card.title, /looks good/i);
  } finally {
    await client.close();
  }
});

test('independent MCP client: retried record_checkin is idempotent', async () => {
  const client = new Client({ name: 'scratch-service-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  await client.connect(transport);
  try {
    const args = {
      senior_id: 'maggie',
      transcript: 'Retry-safety check-in: took my pills with breakfast.',
      idempotency_key: 'scratch-retry-1',
    };
    const first = await client.callTool({ name: 'record_checkin', arguments: args });
    const second = await client.callTool({ name: 'record_checkin', arguments: args });
    assert.equal(second.structuredContent.event_id, first.structuredContent.event_id);
    assert.equal(second.structuredContent.deduplicated, true);

    const journal = await client.callTool({ name: 'get_care_journal', arguments: { senior_id: 'maggie', days: 7 } });
    // 3 seeded + 2 negation chats + 2 meds-status checks + 1 keyed check-in;
    // the retry added nothing.
    assert.equal(journal.structuredContent.count, 8);
  } finally {
    await client.close();
  }
});

test('missed check-in -> late reply resolves card -> RIGHT NOW state is consistent', async (t) => {
  const state0 = await get('/api/state');
  const nextMorning = new Date(state0.clock_now);
  nextMorning.setUTCDate(nextMorning.getUTCDate() + 1);
  nextMorning.setUTCHours(9, 50, 0, 0);
  await post('/api/demo/advance', { to_iso: nextMorning.toISOString() });

  // R1 fired: amber missed-check-in card claiming KinKeeper awaits a reply.
  let inbox = await get('/api/inbox?senior_id=maggie');
  const missed = inbox.cards.find((c) => c.dedupe_key?.startsWith('card:missed:'));
  assert.ok(missed, 'expected a missed-check-in card after the grace deadline');
  assert.match(missed.body, /awaiting a reply/i);

  // The proactive opener is the missed-check-in kind, and peeking is read-only.
  const prompt = await get('/api/proactive?senior_id=maggie');
  assert.equal(prompt.kind, 'missed_checkin');
  assert.match(prompt.prompt, /hadn't heard from you yet today/i);
  const peek = await get('/api/proactive?senior_id=maggie');
  assert.equal(peek.event_id, prompt.event_id, 'GET must not consume the prompt');
  await post('/api/proactive/ack', { senior_id: 'maggie', event_id: prompt.event_id });
  assert.equal((await get('/api/proactive?senior_id=maggie')).prompt, null);

  // Late reply: positive med statement after a contrastive "though".
  const late = await post('/api/chat', { senior_id: 'maggie', message: 'Sorry I overslept — I did take my pills though.' });
  assert.equal(late.facts.meds_taken, true);

  // The missed card is rewritten: no longer awaiting, resolution recorded,
  // and its open/acknowledged state is left untouched.
  inbox = await get('/api/inbox?senior_id=maggie');
  const resolved = inbox.cards.find((c) => c.id === missed.id);
  assert.match(resolved.body, /no longer awaiting a reply/i);
  assert.doesNotMatch(resolved.body, /is awaiting a reply/i);
  assert.equal(resolved.source?.resolved?.by, 'late_checkin');
  assert.equal(resolved.status, 'open', 'resolving facts must not change open/acknowledged state');

  // RIGHT NOW panel data comes from persisted state: a check-in exists AND a
  // risk assessment exists — the pair that used to contradict each other.
  const state = await get('/api/state');
  const maggie = state.seniors[0];
  assert.equal(maggie.checked_in_today, true);
  assert.ok(maggie.last_checkin, 'last_checkin must be present');
  assert.equal(maggie.last_checkin.date, maggie.today);

  // Risk follow-up after a flagged reply has distinct copy and kind.
  const fall = await post('/api/chat', { senior_id: 'maggie', message: 'Oh... I fell in the hallway just now.' });
  assert.equal(fall.risk?.escalate, true);
  assert.ok(fall.risk?.reasons?.length > 0);

  const state1 = await get('/api/state');
  const riskNow = state1.seniors[0].last_risk;
  assert.ok(riskNow, 'last_risk must be served from persisted state');
  assert.ok(['low', 'medium', 'high'].includes(riskNow.level));

  await post('/api/demo/advance', { minutes: 61 }); // fire the scheduled follow-up
  const followupPrompt = await get('/api/proactive?senior_id=maggie');
  assert.equal(followupPrompt.kind, 'risk_followup');
  assert.match(followupPrompt.prompt, /checking back in/i);
  assert.doesNotMatch(followupPrompt.prompt, /hadn't heard from you yet today/i);
});

test('regression: late reply updates an ACKNOWLEDGED missed-check-in card without reopening it', async () => {
  // Advance to a fresh morning past the grace deadline so R1 files a new card.
  const state0 = await get('/api/state');
  const nextMorning = new Date(state0.clock_now);
  nextMorning.setUTCDate(nextMorning.getUTCDate() + 1);
  nextMorning.setUTCHours(9, 50, 0, 0);
  await post('/api/demo/advance', { to_iso: nextMorning.toISOString() });

  let inbox = await get('/api/inbox?senior_id=maggie');
  const missed = inbox.cards.find((c) => c.dedupe_key?.startsWith('card:missed:') && !c.source?.resolved);
  assert.ok(missed, 'expected a fresh missed-check-in card after the grace deadline');
  assert.match(missed.body, /awaiting a reply/i);

  // The family acknowledges (sees) the card BEFORE Maggie replies.
  const acked = await post(`/api/inbox/${missed.id}/ack`, { senior_id: 'maggie' });
  assert.equal(acked.status, 'acknowledged');

  // Maggie replies late — a benign check-in, no escalation involved.
  const late = await post('/api/chat', {
    senior_id: 'maggie',
    message: 'Good morning, sorry I slept in — I did take my pills though.',
  });
  assert.equal(late.facts.meds_taken, true);

  // The acknowledged card must be factually corrected: body and source now
  // say the reply was received, while the acknowledged/seen state remains.
  inbox = await get('/api/inbox?senior_id=maggie');
  const after = inbox.cards.find((c) => c.id === missed.id);
  assert.equal(after.status, 'acknowledged', 'acknowledged/seen state must be preserved');
  assert.equal(after.source?.resolved?.by, 'late_checkin');
  assert.ok(after.source?.resolved?.ts, 'resolution timestamp must be recorded');
  assert.match(after.body, /no longer awaiting a reply/i);
  assert.doesNotMatch(after.body, /is awaiting a reply/i);

  // Resolving twice is a no-op: a second same-day check-in must not rewrite
  // the card again or duplicate the resolution.
  await post('/api/chat', { senior_id: 'maggie', message: 'Just had lunch, feeling fine.' });
  inbox = await get('/api/inbox?senior_id=maggie');
  const again = inbox.cards.find((c) => c.id === missed.id);
  assert.deepEqual(again.source.resolved, after.source.resolved);
  assert.equal(again.body, after.body);
});

test('replayed notify_family / schedule_followup return the original card/follow-up identity', async () => {
  const client = new Client({ name: 'replay-contract-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  await client.connect(transport);
  try {
    const notifyArgs = {
      senior_id: 'maggie',
      title: 'Replay contract check',
      body: 'Synthetic card used to verify the replay response contract.',
      severity: 'info',
      dedupe_key: 'scratch-notify-replay-1',
    };
    const n1 = await client.callTool({ name: 'notify_family', arguments: notifyArgs });
    const n2 = await client.callTool({ name: 'notify_family', arguments: notifyArgs });
    assert.ok(n1.structuredContent.card.id, 'first call must return a card id');
    assert.equal(n2.structuredContent.card.id, n1.structuredContent.card.id, 'replay must return the ORIGINAL card id');
    assert.equal(n2.structuredContent.card.deduplicated, true);
    assert.equal(n2.structuredContent.card.title, notifyArgs.title);
    assert.equal(n2.structuredContent.delivered_externally, false);

    const followupArgs = {
      senior_id: 'maggie',
      reason: 'Replay contract follow-up',
      in_minutes: 120,
      dedupe_key: 'scratch-followup-replay-1',
    };
    const f1 = await client.callTool({ name: 'schedule_followup', arguments: followupArgs });
    const f2 = await client.callTool({ name: 'schedule_followup', arguments: followupArgs });
    assert.ok(f1.structuredContent.followup_id, 'first call must return a follow-up id');
    assert.equal(f2.structuredContent.followup_id, f1.structuredContent.followup_id, 'replay must return the ORIGINAL follow-up id');
    assert.equal(f2.structuredContent.scheduled, true, 'the follow-up IS scheduled — replay must not report scheduled:false');
    assert.equal(f2.structuredContent.deduplicated, true);
    assert.equal(f2.structuredContent.due_ts, f1.structuredContent.due_ts);
    assert.equal(f2.structuredContent.reason, followupArgs.reason);
  } finally {
    await client.close();
  }

  // Side effects stayed singular: exactly one card and one follow-up stored.
  const inbox = await get('/api/inbox?senior_id=maggie');
  assert.equal(inbox.cards.filter((c) => c.dedupe_key === 'scratch-notify-replay-1').length, 1);
  assert.equal(inbox.followups.filter((f) => f.dedupe_key === 'scratch-followup-replay-1').length, 1);
});

test('retry classification is honest about audit-producing reads', async () => {
  const { isSafeToRetry } = await import('../src/mcp/client.js');
  // get_care_journal is the only truly side-effect-free tool.
  assert.equal(isSafeToRetry('get_care_journal', {}), true);
  // These compute from read-only data but append an audit event per call
  // (digest_generated / risk_assessed), so blind retry would double-record.
  assert.equal(isSafeToRetry('get_weekly_digest', {}), false);
  assert.equal(isSafeToRetry('assess_risk', {}), false);
  // Mutations are retried only with a stable idempotency key.
  assert.equal(isSafeToRetry('record_checkin', {}), false);
  assert.equal(isSafeToRetry('record_checkin', { idempotency_key: 'k' }), true);
  assert.equal(isSafeToRetry('notify_family', { dedupe_key: 'k' }), true);
  assert.equal(isSafeToRetry('schedule_followup', { dedupe_key: 'k' }), true);
});

test('regression: low mood yields an attention daily card and a gentle, non-escalating reply', async () => {
  // A senior with no adverse history: "I feel lonely today." extracts
  // mood:-1, which makes the daily card NEEDS ATTENTION (amber) — the Today
  // hero must reflect that same fact (verified in the browser pass) — while
  // a single low-mood day with a calm window must NOT mint a family card.
  server.store.upsertSenior({
    id: 'quiet',
    display_name: 'Quiet Tester',
    checkin_time: '09:00',
    grace_minutes: 45,
    concerns: [],
    family_contact: '',
    created_ts: new Date().toISOString(),
  });
  const res = await post('/api/chat', { senior_id: 'quiet', message: 'I feel lonely today.' });
  assert.ok(res.facts.mood < 0, 'lonely is a negative-mood extraction');

  const daily = res.cards.find((c) => c.kind === 'daily_status');
  assert.ok(daily, 'expected a daily status card');
  assert.equal(daily.severity, 'amber');
  assert.match(daily.title, /needs a little attention/i);
  assert.doesNotMatch(daily.title, /looks good/i);
  assert.ok(daily.lines.some((l) => /sounded low/.test(l)), 'the card explains its attention state');

  assert.equal(res.escalated, false, 'one low-mood day on a calm history must not escalate');
  assert.equal(res.card_created_this_turn, false);
  assert.ok(!res.cards.some((c) => String(c.dedupe_key || '').startsWith('escalation:')));
  assert.ok(!res.tool_calls.includes('notify_family'));
  const inbox = await get('/api/inbox?senior_id=quiet');
  assert.equal(inbox.cards.length, 0, 'no family card for a non-escalating low-mood day');

  // The companion reply is gentle and non-diagnostic, and claims no family
  // note, no notification, and no emergency capability.
  assert.match(res.reply, /sorry today feels heavy/i);
  assert.match(res.reply, /someone close to you/i);
  assert.doesNotMatch(res.reply, /left a note/i);
  assert.doesNotMatch(res.reply, /diagnos/i);
  assert.doesNotMatch(res.reply, /emergency number/i);
});

test('mixed negation keeps the affirmed fall, and bad clock input cannot poison state', async () => {
  const db = path.join(os.tmpdir(), `kinkeeper-clause-clock-${process.pid}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(db + suffix); } catch {}
  }
  const isolated = await startServer({ port: 8874, dbPath: db, tickMs: 60_000 });
  const base = 'http://127.0.0.1:8874';
  const send = async (pathname, body, { raw = false } = {}) => {
    const res = await fetch(`${base}${pathname}`, body === undefined ? undefined : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json };
  };
  try {
    const message = 'I did not fall yesterday, but I fell today.';
    const chat = await send('/api/chat', { senior_id: 'maggie', message });
    assert.equal(chat.status, 200);
    assert.ok(chat.json.facts.risk_flags.includes('fall'));
    assert.ok(!chat.json.facts.negated_flags.includes('fall'));
    const daily = chat.json.cards.find((c) => c.kind === 'daily_status');
    assert.equal(daily.severity, 'amber');
    assert.doesNotMatch(daily.title, /looks good/i);
    assert.match(daily.title, /needs a little attention/i);
    assert.doesNotMatch(daily.title, /diagnos/i);
    assert.ok(daily.lines.some((l) => l === 'Mentioned: fall'));
    assert.ok(!daily.lines.some((l) => /Ruled out by them:.*fall/.test(l)));

    const journal = await send('/api/journal?senior_id=maggie');
    const entry = journal.json.entries.find((e) => e.excerpt === message);
    assert.ok(entry, 'journal excerpt must be the exact words');
    assert.equal(entry.excerpt, message);

    const inbox = await send('/api/inbox?senior_id=maggie');
    const quoted = inbox.json.cards.find((c) => c.quote === message);
    assert.ok(quoted, 'family card must quote the exact utterance');
    assert.equal(quoted.why.quote, message);
    assert.match(quoted.why.facts.join(' '), /fall/);
    assert.doesNotMatch(quoted.body, /diagnos/i);
    assert.match(quoted.body, /not a medical assessment/i);

    const digest = await send('/api/digest', { senior_id: 'maggie' });
    assert.equal(digest.status, 200);
    assert.ok(digest.json.risk_days.includes(entry.date));

    const reversed = await send('/api/chat', {
      senior_id: 'maggie',
      message: 'I fell today, but I did not fall yesterday.',
    });
    assert.ok(reversed.json.facts.risk_flags.includes('fall'));
    assert.ok(!reversed.json.facts.negated_flags.includes('fall'));

    const denied = await send('/api/chat', {
      senior_id: 'maggie',
      message: 'I did not fall yesterday and I did not fall today.',
    });
    assert.deepEqual(denied.json.facts.risk_flags, []);
    assert.ok(denied.json.facts.negated_flags.includes('fall'));
    const deniedDaily = denied.json.cards.find((c) => c.kind === 'daily_status');
    assert.ok(!deniedDaily.lines.some((l) => l === 'Mentioned: fall'));

    const state0 = await send('/api/state');
    assert.equal(state0.status, 200);
    const started = Date.parse(state0.json.clock_now);
    assert.equal(Number.isFinite(started), true);
    const badBodies = [
      { raw: '{"to_iso":"banana"}' },
      { raw: '{"minutes":1e309}' },
      { json: { minutes: 'Infinity' } },
      { json: { minutes: true } },
      { json: { to_iso: { nope: 1 } } },
      { json: { minutes: 1e20 } },
      { json: { minutes: 'banana' } },
      { json: { minutes: null } },
    ];
    for (const body of badBodies) {
      const label = body.raw || JSON.stringify(body.json);
      const adv = await send('/api/demo/advance', body.raw ?? body.json, { raw: body.raw != null });
      assert.equal(adv.status, 400, label);
      assert.equal(typeof adv.json?.error, 'string', label);
      const state = await send('/api/state');
      assert.equal(state.status, 200, label);
      const drift = Date.parse(state.json.clock_now) - started;
      assert.equal(Number.isFinite(Date.parse(state.json.clock_now)), true, label);
      assert.ok(drift >= 0 && drift < 30_000, `${label} moved the clock by ${drift}ms`);
    }

    const beforeValid = Date.parse((await send('/api/state')).json.clock_now);
    const ok = await send('/api/demo/advance', { minutes: 1 });
    assert.equal(ok.status, 200);
    const jumped = Date.parse(ok.json.now) - beforeValid;
    assert.ok(jumped >= 60_000 && jumped < 70_000, `valid advance delta ${jumped}`);
    const restored = await send('/api/demo/advance', { to_iso: state0.json.clock_now });
    assert.equal(restored.status, 200);
    assert.equal(Number.isFinite(Date.parse(restored.json.now)), true);
  } finally {
    await isolated.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(db + suffix); } catch {}
    }
  }
});
