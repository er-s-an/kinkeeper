// Scratch-service test for Dana's family action loop and the "Why this card?"
// evidence. Boots the real KinKeeper server on its own port with its own
// throwaway SQLite database (never the dev DB, never ports 8787/8788/8792/
// 8794/8797) and exercises action persistence, idempotency, validation, the
// late-reply interplay, and evidence truthfulness end-to-end over HTTP.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `kinkeeper-family-actions-test-${process.pid}.db`);

let server;

const post = (p, body) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
// Status-aware variant for asserting exact 400/404/200 codes.
const postRaw = (p, body) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (p) => fetch(`${BASE}${p}`).then((r) => r.json());

const FALL_MESSAGE = "Oh... I fell yesterday. I'm fine, really.";

let fallCardId;
let missedCardId;

// NOTE: Node v22.0.0's runner does not await a top-level before() hook before
// starting tests, so scenario setup uses module-level top-level await — test
// execution cannot begin until module evaluation (and thus setup) completes.
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.rmSync(DB + suffix); } catch {}
}
server = await startServer({ port: PORT, dbPath: DB, tickMs: 250 });

// Day 1: a genuine current-message fall -> amber escalation card with quote.
const fall = await post('/api/chat', { senior_id: 'maggie', message: FALL_MESSAGE });
assert.equal(fall.escalated, true);
const fallCard = fall.cards.find((c) => String(c.dedupe_key || '').startsWith('escalation:'));
assert.ok(fallCard, 'expected an escalation card to act on');
fallCardId = fallCard.id;

// Day 2, past the grace deadline -> R1 missed-check-in card.
const state0 = await get('/api/state');
const day2 = new Date(state0.clock_now);
day2.setUTCDate(day2.getUTCDate() + 1);
day2.setUTCHours(9, 50, 0, 0);
await post('/api/demo/advance', { to_iso: day2.toISOString() });
const setupInbox = await get('/api/inbox?senior_id=maggie');
const missedCard = setupInbox.cards.find((c) => String(c.dedupe_key || '').startsWith('card:missed:'));
assert.ok(missedCard, 'expected a missed-check-in card to act on');
missedCardId = missedCard.id;

after(async () => {
  await server?.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB + suffix); } catch {}
  }
});

test('action recording persists, stays chronological, and closes after "reached"', async () => {
  const planned = await post(`/api/inbox/${missedCardId}/action`, { senior_id: 'maggie', action: 'plan_call' });
  assert.equal(planned.ok, true);
  assert.equal(planned.deduplicated, false);
  assert.ok(planned.recorded?.ts, 'the record carries the virtual-clock timestamp');
  assert.match(planned.truth_note, /no call is placed/i);
  assert.equal(planned.card.status, 'open', 'recording an action does not mark the card seen');

  let inbox = await get('/api/inbox?senior_id=maggie');
  let card = inbox.cards.find((c) => c.id === missedCardId);
  assert.deepEqual(card.actions, [{ action: 'plan_call', ts: planned.recorded.ts }]);
  assert.ok(!card.available_actions.includes('plan_call'), 'recorded steps are not offered again');
  assert.ok(card.available_actions.includes('tried_call'));
  assert.ok(card.available_actions.includes('reached'));
  assert.ok(card.available_actions.includes('follow_up_later'));

  // Chronological factual timeline: created first, the action after it.
  assert.equal(card.timeline[0].kind, 'created');
  const actionEntry = card.timeline.find((t) => t.kind === 'action');
  assert.equal(actionEntry.action, 'plan_call');
  assert.ok(actionEntry.ts >= card.timeline[0].ts, 'action is not dated before the card existed');

  await post(`/api/inbox/${missedCardId}/action`, { senior_id: 'maggie', action: 'tried_call' });
  const reached = await post(`/api/inbox/${missedCardId}/action`, { senior_id: 'maggie', action: 'reached' });
  assert.deepEqual(reached.available_actions, [], 'the loop is complete once Maggie was reached');

  inbox = await get('/api/inbox?senior_id=maggie');
  card = inbox.cards.find((c) => c.id === missedCardId);
  assert.deepEqual(card.actions.map((a) => a.action), ['plan_call', 'tried_call', 'reached']);
  assert.deepEqual(card.available_actions, []);

  // A further, different step is rejected once the loop is complete.
  const late = await post(`/api/inbox/${missedCardId}/action`, { senior_id: 'maggie', action: 'follow_up_later' });
  assert.match(late.error, /not available/);
});

test('idempotent double submit replays the original record exactly once', async () => {
  const first = await post(`/api/inbox/${fallCardId}/action`, { senior_id: 'maggie', action: 'tried_call' });
  assert.equal(first.deduplicated, false);
  const second = await post(`/api/inbox/${fallCardId}/action`, { senior_id: 'maggie', action: 'tried_call' });
  assert.equal(second.ok, true);
  assert.equal(second.deduplicated, true);
  assert.equal(second.recorded.ts, first.recorded.ts, 'replay returns the original timestamp');

  const inbox = await get('/api/inbox?senior_id=maggie');
  const card = inbox.cards.find((c) => c.id === fallCardId);
  assert.equal(card.actions.filter((a) => a.action === 'tried_call').length, 1, 'one timeline step, not two');
  assert.equal(
    server.store.db.prepare('SELECT COUNT(*) AS n FROM card_actions WHERE card_id = ? AND action = ?')
      .get(fallCardId, 'tried_call').n,
    1
  );
  // The event stream mirrors the single record.
  assert.equal(
    server.store.getEvents('maggie', { type: 'family_action_recorded' })
      .filter((e) => e.payload.card_id === fallCardId && e.payload.action === 'tried_call').length,
    1
  );
});

test('validation: wrong senior, unknown action, unknown card, non-actionable card', async () => {
  const missing = await post(`/api/inbox/${fallCardId}/action`, { senior_id: 'maggie' });
  assert.match(missing.error, /required/);

  const unknownSenior = await post(`/api/inbox/${fallCardId}/action`, { senior_id: 'nobody', action: 'plan_call' });
  assert.match(unknownSenior.error, /unknown senior_id/);

  // A real but different senior must not act on Maggie's card.
  server.store.upsertSenior({
    id: 'other',
    display_name: 'Other Person',
    checkin_time: '09:00',
    grace_minutes: 45,
    concerns: [],
    family_contact: '',
    created_ts: new Date().toISOString(),
  });
  const wrongOwner = await post(`/api/inbox/${fallCardId}/action`, { senior_id: 'other', action: 'plan_call' });
  assert.match(wrongOwner.error, /does not belong/);

  const badAction = await post(`/api/inbox/${fallCardId}/action`, { senior_id: 'maggie', action: 'teleport' });
  assert.match(badAction.error, /unknown action/);

  const noCard = await post('/api/inbox/99999/action', { senior_id: 'maggie', action: 'plan_call' });
  assert.match(noCard.error, /card not found/);

  // Informational cards stay read-only: no action loop on them.
  const info = server.store.addCard({
    created_ts: server.clock.nowIso(),
    senior_id: 'maggie',
    severity: 'info',
    title: 'Replay contract check',
    body: 'Synthetic informational card.',
    quote: null,
    suggested_action: null,
    source: { via: 'mcp:notify_family' },
    dedupe_key: `family-actions-test-info-${process.pid}`,
  });
  const onInfo = await post(`/api/inbox/${info.id}/action`, { senior_id: 'maggie', action: 'plan_call' });
  assert.match(onInfo.error, /no follow-up action loop/);
  assert.equal(onInfo.ok, undefined);
});

test('late reply updates card copy while Dana\'s recorded steps persist', async () => {
  // Dana already planned/tried/reached on the missed card (first test).
  // Maggie now replies late: factual copy updates, the human steps remain.
  const late = await post('/api/chat', { senior_id: 'maggie', message: 'Sorry I overslept — I did take my pills though.' });
  assert.equal(late.facts.meds_taken, true);

  const inbox = await get('/api/inbox?senior_id=maggie');
  const card = inbox.cards.find((c) => c.id === missedCardId);
  assert.match(card.body, /no longer awaiting a reply/i);
  assert.doesNotMatch(card.body, /is awaiting a reply/i);
  assert.deepEqual(card.actions.map((a) => a.action), ['plan_call', 'tried_call', 'reached'],
    'Dana\'s recorded steps survive the late-reply rewrite');

  const kinds = card.timeline.map((t) => t.kind);
  assert.ok(kinds.includes('replied'), 'timeline shows the late reply');
  assert.equal(kinds.filter((k) => k === 'action').length, 3);
  assert.equal(kinds[0], 'created');
  const repliedIdx = kinds.indexOf('replied');
  assert.ok(repliedIdx > 0, 'reply is ordered after creation');
});

test('why-this-card evidence is truthful plain language from the real journal', async () => {
  const inbox = await get('/api/inbox?senior_id=maggie');
  const fallCard = inbox.cards.find((c) => c.id === fallCardId);
  const missedCard = inbox.cards.find((c) => c.id === missedCardId);

  // Escalation card: exact verbatim quote, plain wording, no engineering IDs.
  assert.equal(fallCard.why.quote, FALL_MESSAGE, 'evidence quotes Maggie exactly');
  assert.match(fallCard.why.summary, /worrying/i);
  const whyText = JSON.stringify(fallCard.why) + JSON.stringify(missedCard.why);
  assert.doesNotMatch(whyText, /R1_MISSED_CHECKIN|R3_REPEATED_TOPIC|deterministic rules|\(\+\d+\)/,
    'no rule IDs, scoring jargon, or point math in the explanation');
  assert.ok(fallCard.why.facts.some((f) => /mentioned: fall/.test(f)));
  assert.ok(fallCard.why.facts.some((f) => /not a medical assessment/.test(f)));

  // Missed-check-in card: observed timing facts, and 7-day context that only
  // names days that really exist in the journal.
  assert.ok(missedCard.why.facts.some((f) => /due at 09:00/.test(f)));
  assert.ok(missedCard.why.facts.some((f) => /45-minute grace/.test(f)));
  assert.ok(missedCard.why.facts.some((f) => /has since replied/.test(f)),
    'why-evidence stays current after the late reply');
  const journal = await get('/api/journal?senior_id=maggie&days=7');
  const journalDates = new Set(journal.entries.map((e) => e.date));
  for (const line of missedCard.why.context) {
    for (const m of line.matchAll(/(\w{3}), (\w{3}) (\d+)/g)) {
      const isoish = new Date(`${m[2]} ${m[3]}, 2026 12:00 UTC`).toISOString().slice(0, 10);
      assert.ok(journalDates.has(isoish), `context date ${isoish} must come from the actual journal`);
    }
  }
});

test('regression: old card why-context stays anchored at creation after a next-day event', async () => {
  const before = (await get('/api/inbox?senior_id=maggie')).cards.find((c) => c.id === fallCardId);
  const contextBefore = JSON.stringify(before.why.context);

  // The next day Maggie mentions another fall. That must create a NEW card —
  // and must NOT rewrite the OLD card's creation rationale (the time-travel
  // defect: the old card's context used to absorb the later event).
  const state = await get('/api/state');
  const day3 = new Date(state.clock_now);
  day3.setUTCDate(day3.getUTCDate() + 1);
  day3.setUTCHours(9, 50, 0, 0);
  await post('/api/demo/advance', { to_iso: day3.toISOString() });
  const again = await post('/api/chat', { senior_id: 'maggie', message: 'I fell again this morning, but I am okay.' });
  assert.equal(again.escalated, true);
  const newCard = again.cards.find((c) => String(c.dedupe_key || '').startsWith('escalation:'));
  assert.ok(newCard && newCard.id !== fallCardId, 'the new fall is its own card');

  const after = (await get('/api/inbox?senior_id=maggie')).cards.find((c) => c.id === fallCardId);
  assert.equal(
    JSON.stringify(after.why.context),
    contextBefore,
    'creation-anchored context must not change when later events arrive'
  );
  assert.equal(after.why.quote, FALL_MESSAGE, 'the original verbatim quote is preserved');
  const laterDay = day3
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  assert.ok(
    !JSON.stringify(after.why.context).includes(laterDay),
    `the later day (${laterDay}) must not appear in the old card's why-context`
  );
});

test('ack requires senior ownership: 400 on mismatch/missing/unknown, 404 on missing card, no mutation on failure', async () => {
  const before = (await get('/api/inbox?senior_id=maggie')).cards.find((c) => c.id === missedCardId);
  assert.equal(before.status, 'open');
  assert.equal(before.ack_ts ?? null, null);

  const missingParam = await postRaw(`/api/inbox/${missedCardId}/ack`, {});
  assert.equal(missingParam.status, 400);
  assert.match(missingParam.body.error, /senior_id is required/);

  const unknownSenior = await postRaw(`/api/inbox/${missedCardId}/ack`, { senior_id: 'nobody' });
  assert.equal(unknownSenior.status, 400);
  assert.match(unknownSenior.body.error, /unknown senior_id/);

  // A real but different senior must not mark Maggie's card seen.
  const crossSenior = await postRaw(`/api/inbox/${missedCardId}/ack`, { senior_id: 'other' });
  assert.equal(crossSenior.status, 400);
  assert.match(crossSenior.body.error, /does not belong/);

  const missingCard = await postRaw('/api/inbox/99999/ack', { senior_id: 'maggie' });
  assert.equal(missingCard.status, 404);
  assert.match(missingCard.body.error, /card not found/);

  // Garbage card ids are guarded too (NaN must not reach the store).
  const invalidId = await postRaw('/api/inbox/not-a-number/ack', { senior_id: 'maggie' });
  assert.equal(invalidId.status, 404);

  // No failure above may have mutated the card or the event stream.
  const after = (await get('/api/inbox?senior_id=maggie')).cards.find((c) => c.id === missedCardId);
  assert.equal(after.status, 'open', 'failed acks must not mark the card seen');
  assert.equal(after.ack_ts ?? null, null, 'failed acks must not stamp a seen time');
  assert.equal(
    server.store.getEvents('maggie', { type: 'family_card_seen' }).filter((e) => e.payload.card_id === missedCardId).length,
    0,
    'failed acks must not write seen events'
  );
});


test('seen timestamp is real; a duplicate ack replays without a second seen record', async () => {
  // Correct own ack: the owning senior marks her own card seen.
  const acked = await post(`/api/inbox/${fallCardId}/ack`, { senior_id: 'maggie' });
  assert.equal(acked.status, 'acknowledged');
  const seenEntry = acked.timeline.find((t) => t.kind === 'seen');
  assert.ok(seenEntry?.ts, 'new acknowledgements record when the card was seen');
  assert.equal(seenEntry.ts, acked.ack_ts);

  // Duplicate ack: same 200 state, original timestamp kept, no second event.
  const again = await postRaw(`/api/inbox/${fallCardId}/ack`, { senior_id: 'maggie' });
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'acknowledged');
  assert.equal(again.body.ack_ts, acked.ack_ts, 'a duplicate ack must not move the seen timestamp');
  assert.equal(
    server.store.getEvents('maggie', { type: 'family_card_seen' }).filter((e) => e.payload.card_id === fallCardId).length,
    1,
    'one seen event per card, not two'
  );

  // Simulate a card acknowledged before the ack_ts column existed: the
  // timeline still says "seen", honestly without a time.
  server.store.db.prepare('UPDATE inbox_cards SET ack_ts = NULL WHERE id = ?').run(fallCardId);
  const inbox = await get('/api/inbox?senior_id=maggie');
  const legacy = inbox.cards.find((c) => c.id === fallCardId);
  const legacySeen = legacy.timeline.find((t) => t.kind === 'seen');
  assert.ok(legacySeen, 'seen fact remains');
  assert.equal(legacySeen.ts, null, 'no invented timestamp for pre-migration data');
});

test('actions and why-evidence survive a server restart (same scratch DB)', async () => {
  await server.close();
  server = await startServer({ port: PORT, dbPath: DB, tickMs: 250 });
  let inbox;
  for (let i = 0; i < 10; i++) {
    try {
      inbox = await get('/api/inbox?senior_id=maggie');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const card = inbox.cards.find((c) => c.id === missedCardId);
  assert.deepEqual(card.actions.map((a) => a.action), ['plan_call', 'tried_call', 'reached']);
  assert.equal(card.timeline.filter((t) => t.kind === 'action').length, 3);
  assert.match(card.body, /no longer awaiting a reply/i, 'late-reply copy survives restart');
  assert.ok(card.why.summary.length > 0, 'why-evidence is rebuilt from persisted state');
});
