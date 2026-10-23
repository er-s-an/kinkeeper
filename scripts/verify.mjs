// End-to-end verification for KinKeeper.
// Boots the real server on a scratch database, drives it with an independent
// MCP client (official SDK, Streamable HTTP), walks the whole demo scenario,
// then restarts the server to prove cross-session persistence.
// Usage: node scripts/verify.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, '..', 'data', 'verify.db');
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label} ${extra}`);
  }
}

const post = (p, body) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const get = (p) => fetch(`${BASE}${p}`).then((r) => r.json());

async function connectMcp() {
  const client = new Client({ name: 'kinkeeper-verifier', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  await client.connect(transport);
  return { client, transport };
}

// Retry transient failures (e.g. undici reusing a keep-alive socket that
// belonged to the pre-restart server instance).
async function withRetry(fn, attempts = 5, delayMs = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

for (const suffix of ['', '-wal', '-shm']) {
  try { fs.rmSync(DB + suffix); } catch {}
}

console.log('\n== 1. Boot server + MCP handshake ==');
let server = await startServer({ port: PORT, dbPath: DB, tickMs: 400 });
let { client, transport } = await connectMcp();
const negotiated = client.protocolVersion ?? transport.protocolVersion ?? null;
console.log(`  negotiated protocol version: ${negotiated}`);
check('MCP protocol version is 2025-11-25', negotiated === '2025-11-25', `(got ${negotiated})`);

const tools = await client.listTools();
const toolNames = tools.tools.map((t) => t.name).sort();
check(
  'six tools exposed',
  JSON.stringify(toolNames) ===
    JSON.stringify(
      ['assess_risk', 'get_care_journal', 'get_weekly_digest', 'notify_family', 'record_checkin', 'schedule_followup'].sort()
    ),
  `(got ${toolNames})`
);

console.log('\n== 2. Direct MCP tool calls (independent client) ==');
const rec = await client.callTool({
  name: 'record_checkin',
  arguments: { senior_id: 'maggie', transcript: 'I slept 7 hours, took my meds, walked the dog. Feeling good today.' },
});
check('record_checkin returns structured facts', rec.structuredContent?.facts?.sleep_hours === 7);
check('record_checkin green daily card', rec.structuredContent?.card?.severity === 'green');

const journal = await client.callTool({ name: 'get_care_journal', arguments: { senior_id: 'maggie', days: 7 } });
check('journal returns seeded history + new entry', (journal.structuredContent?.count ?? 0) === 4);

const risk0 = await client.callTool({ name: 'assess_risk', arguments: { senior_id: 'maggie' } });
check('baseline risk does not escalate', risk0.structuredContent?.escalate === false);

console.log('\n== 2b. Idempotent retry of a mutating tool ==');
const replayArgs = {
  senior_id: 'maggie',
  transcript: 'Retry safety check — took my meds with breakfast.',
  idempotency_key: 'verify-retry-1',
};
const replay1 = await client.callTool({ name: 'record_checkin', arguments: replayArgs });
const replay2 = await client.callTool({ name: 'record_checkin', arguments: replayArgs });
check(
  'retried record_checkin returns the original event',
  replay2.structuredContent?.event_id === replay1.structuredContent?.event_id &&
    replay2.structuredContent?.deduplicated === true,
  `(ids ${replay1.structuredContent?.event_id} vs ${replay2.structuredContent?.event_id})`
);
const journalAfterReplay = await client.callTool({ name: 'get_care_journal', arguments: { senior_id: 'maggie', days: 7 } });
check(
  'retry created no duplicate journal entry',
  journalAfterReplay.structuredContent?.count === 5,
  `(got ${journalAfterReplay.structuredContent?.count})`
);

console.log('\n== 3. Deterministic missed check-in -> family inbox card ==');
// Advance virtual clock to next day 09:50 (past 09:00 + 45m grace).
await post('/api/demo/advance', { minutes: 1500 });
await new Promise((r) => setTimeout(r, 600)); // let a scheduler tick pass
let inbox = await get('/api/inbox?senior_id=maggie');
const missedCards = inbox.cards.filter((c) => c.dedupe_key?.startsWith('card:missed:'));
check('amber missed-check-in card created by rules engine', missedCards.length === 1);
check('missed card has a suggested action', /call/i.test(missedCards[0]?.suggested_action || ''));
check('no external delivery on rule cards', !('delivered_externally' in (missedCards[0] || {})) || missedCards[0].delivered_externally === false);

console.log('\n== 4. Proactive re-engagement (system speaks first) ==');
const proactive = await get('/api/proactive?senior_id=maggie');
check('proactive prompt available after missed check-in', typeof proactive.prompt === 'string' && proactive.prompt.length > 10);
check('missed-check-in prompt uses missed-check-in copy', /hadn't heard from you yet today/i.test(proactive.prompt) && proactive.kind === 'missed_checkin');
const proactivePeek = await get('/api/proactive?senior_id=maggie');
check('GET peeks without marking delivered', proactivePeek.prompt === proactive.prompt && proactivePeek.event_id === proactive.event_id);
await post('/api/proactive/ack', { senior_id: 'maggie', event_id: proactive.event_id });
const proactiveAgain = await get('/api/proactive?senior_id=maggie');
check('prompt is retired only after explicit ack', proactiveAgain.prompt === null);

console.log('\n== 5. Vague fall reply -> risk escalation ==');
const turn = await post('/api/chat', {
  senior_id: 'maggie',
  message: "Oh... I fell yesterday in the kitchen. I'm fine, really.",
});
check('orchestrator called the MCP tools in order',
  JSON.stringify(turn.tool_calls) ===
    JSON.stringify(['record_checkin', 'get_care_journal', 'assess_risk', 'notify_family', 'schedule_followup']),
  `(got ${turn.tool_calls})`);
check('risk escalated to high', turn.risk?.level === 'high' && turn.risk?.escalate === true);
check('reply includes emergency disclaimer', /emergency/i.test(turn.reply));
inbox = await get('/api/inbox?senior_id=maggie');
const escCard = inbox.cards.find((c) => c.title?.includes('Please check on'));
check('family escalation card exists with verbatim quote', Boolean(escCard?.quote?.includes('fell')));
check('escalation card is amber and actionable', escCard?.severity === 'amber' && /call/i.test(escCard?.suggested_action || ''));

console.log('\n== 5b. Late reply resolves the missed-check-in card ==');
const missedAfter = inbox.cards.find((c) => c.dedupe_key?.startsWith('card:missed:'));
check('missed card no longer claims to be awaiting a reply', /no longer awaiting a reply/i.test(missedAfter?.body || ''));
check('missed card records the late-checkin resolution', missedAfter?.source?.resolved?.by === 'late_checkin');

console.log('\n== 5c. Dana\'s family action loop + why-this-card evidence ==');
const act1 = await post(`/api/inbox/${escCard.id}/action`, { senior_id: 'maggie', action: 'plan_call' });
check('family action recorded with a real timestamp',
  act1.ok === true && act1.deduplicated === false && Boolean(act1.recorded?.ts));
const act2 = await post(`/api/inbox/${escCard.id}/action`, { senior_id: 'maggie', action: 'plan_call' });
check('double submit replays the original record',
  act2.deduplicated === true && act2.recorded?.ts === act1.recorded?.ts);
const wrongSenior = await post(`/api/inbox/${escCard.id}/action`, { senior_id: 'nobody', action: 'plan_call' });
check('action for the wrong senior is rejected', Boolean(wrongSenior.error));
const badAction = await post(`/api/inbox/${escCard.id}/action`, { senior_id: 'maggie', action: 'teleport' });
check('unknown action is rejected', Boolean(badAction.error));
inbox = await get('/api/inbox?senior_id=maggie');
const escAfter = inbox.cards.find((c) => c.id === escCard.id);
check('chronological timeline lists the recorded step',
  escAfter?.timeline?.[0]?.kind === 'created' &&
    escAfter.timeline.some((t) => t.kind === 'action' && t.action === 'plan_call'));
check('why-this-card quotes Maggie exactly',
  escAfter?.why?.quote === "Oh... I fell yesterday in the kitchen. I'm fine, really.");
check('why-this-card is plain language (no rule IDs or scoring jargon)',
  !/R\d_|\(\+\d+\)|deterministic rules/i.test(JSON.stringify(escAfter?.why || {})));

const ackNoSenior = await post(`/api/inbox/${escCard.id}/ack`, {});
check('ack without senior_id is rejected (400)', Boolean(ackNoSenior.error));
const ackWrongSenior = await post(`/api/inbox/${escCard.id}/ack`, { senior_id: 'nobody' });
check('ack for the wrong senior is rejected (400)', Boolean(ackWrongSenior.error));
const ackMissing = await post('/api/inbox/99999/ack', { senior_id: 'maggie' });
check('ack for a missing card is rejected (404)', Boolean(ackMissing.error));
const ackOk = await post(`/api/inbox/${escCard.id}/ack`, { senior_id: 'maggie' });
check('own ack marks the card seen with a real timestamp',
  ackOk.status === 'acknowledged' && Boolean(ackOk.ack_ts));

console.log('\n== 6. Cross-session recall ==');
const recallTurn = await post('/api/chat', {
  senior_id: 'maggie',
  message: 'Took my meds. My knee is sore again this morning.',
});
check('companion recalls prior-day knee mentions', (recallTurn.recall?.[0]?.prior_dates?.length ?? 0) >= 2);
check('recall line names the earlier days', /Oct/i.test(recallTurn.recall?.[0]?.line || ''));

console.log('\n== 7. Weekly digest ==');
const digest = await post('/api/digest', { senior_id: 'maggie' });
check('digest covers 7-day window', digest.period && digest.checkin_completion?.out_of === 7);
check('digest surfaces recurring topic with quote',
  digest.recurring_topics?.some((t) => t.topic === 'knee' && t.example_quote?.length > 0));

console.log('\n== 8. Audit trail of real MCP calls ==');
const audit = (await get('/api/audit?limit=500')).entries;
const initRow = audit.find((r) => r.method === 'initialize');
check('initialize logged with protocolVersion 2025-11-25', initRow?.detail?.protocolVersion === '2025-11-25');
const toolCalls = audit.filter((r) => r.method === 'tools/call' && r.direction === 'mcp-in');
check('every tool call logged (mcp-in/mcp-out pairs)', toolCalls.length >= 9, `(got ${toolCalls.length})`);
const notifyOut = audit.find((r) => r.method === 'tools/call' && r.direction === 'mcp-out' && r.detail?.tool === 'notify_family');
check('notify_family result records delivered_externally=false', notifyOut?.detail?.result?.delivered_externally === false);

console.log('\n== 9. Cross-session persistence (server restart, same DB) ==');
await client.close();
await server.close();
server = await startServer({ port: PORT, dbPath: DB, tickMs: 400 });
({ client, transport } = await withRetry(connectMcp));
const journal2 = await withRetry(() =>
  client.callTool({ name: 'get_care_journal', arguments: { senior_id: 'maggie', days: 30 } })
);
check('journal survives restart', (journal2.structuredContent?.count ?? 0) >= 6, `(got ${journal2.structuredContent?.count})`);
const inbox2 = await get('/api/inbox?senior_id=maggie');
check('inbox cards survive restart', inbox2.cards.some((c) => c.title?.includes('Please check on')));
check('family actions survive restart',
  inbox2.cards.find((c) => c.id === escCard.id)?.actions?.some((a) => a.action === 'plan_call'));

await client.close();
await server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
