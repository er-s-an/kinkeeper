// Scratch-service regression test for the P1 false-escalation repair.
// Boots the real KinKeeper server on its own port with its own throwaway
// SQLite database (never the dev DB, never ports 8787/8788/8792) and replays
// the confirmed reproduction: a real risk yesterday keeps the 72h assessment
// elevated, so a benign reply today must NOT mint a fresh family worry card,
// a fresh risk follow-up, or companion wording implying this utterance was
// worrying — while a genuine current-message risk still escalates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `kinkeeper-escalation-test-${process.pid}.db`);

let server;

const post = (p, body) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const get = (p) => fetch(`${BASE}${p}`).then((r) => r.json());

const escalationCards = (inbox) =>
  inbox.cards.filter((c) => String(c.dedupe_key || '').startsWith('escalation:'));
const escFollowups = (inbox) =>
  inbox.followups.filter((f) => String(f.dedupe_key || '').startsWith('esc-followup:'));

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

test('prior-day risk -> benign next-day reply creates no fresh escalation', async () => {
  // --- Day 1: a REAL current-message risk. Same-day escalation must fire.
  const fall = await post('/api/chat', {
    senior_id: 'maggie',
    message: "Oh... I fell yesterday. I'm fine, really.",
  });
  assert.equal(fall.escalated, true, 'a current-message fall must still escalate same-day');
  assert.equal(fall.risk?.escalate, true);
  const fallCard = fall.cards.find((c) => String(c.dedupe_key || '').startsWith('escalation:'));
  assert.ok(fallCard, 'expected a same-day escalation card');
  assert.equal(fallCard.severity, 'amber');
  assert.equal(fallCard.quote, "Oh... I fell yesterday. I'm fine, really.");
  assert.match(fallCard.body, /mentioned something worrying in today's check-in/);
  assert.match(fall.reply, /sounds worrying/);
  assert.match(fall.reply, /emergency number/);

  const inboxDay1 = await get('/api/inbox?senior_id=maggie');
  assert.equal(escalationCards(inboxDay1).length, 1);
  assert.equal(escFollowups(inboxDay1).length, 1, 'one risk follow-up for the real event');

  // Same-day replay of the identical fall message: the family card and the
  // follow-up deduplicate, and the escalation_completed audit event must be
  // recorded exactly once for the stable check-in event (was 2 -> 3 before).
  const escCompleted = () =>
    server.store.getEvents('maggie', { type: 'escalation_completed' });
  assert.equal(escCompleted().length, 1);
  assert.match(escCompleted()[0].dedupe_key, /^esc-completed:\d+$/);
  assert.equal(escCompleted()[0].dedupe_key, `esc-completed:${escCompleted()[0].payload.event_id}`);
  const replayFall = await post('/api/chat', {
    senior_id: 'maggie',
    message: "Oh... I fell yesterday. I'm fine, really.",
  });
  assert.equal(replayFall.escalated, true, 'replay still resolves to the same escalation turn');
  assert.equal(replayFall.cards.filter((c) => String(c.dedupe_key || '').startsWith('escalation:')).length, 1);
  const inboxReplayFall = await get('/api/inbox?senior_id=maggie');
  assert.equal(escalationCards(inboxReplayFall).length, 1, 'no duplicate escalation card on replay');
  assert.equal(escFollowups(inboxReplayFall).length, 1, 'no duplicate risk follow-up on replay');
  assert.equal(escCompleted().length, 1, 'escalation_completed is idempotent for the stable check-in event');

  // --- Day 2, past the check-in deadline: the missed-check-in card is legitimate.
  const state0 = await get('/api/state');
  const day2 = new Date(state0.clock_now);
  day2.setUTCDate(day2.getUTCDate() + 1);
  day2.setUTCHours(9, 50, 0, 0);
  await post('/api/demo/advance', { to_iso: day2.toISOString() });
  const day2Str = day2.toISOString().slice(0, 10);

  const inboxBefore = await get('/api/inbox?senior_id=maggie');
  const missed = inboxBefore.cards.find((c) => c.dedupe_key === `card:missed:${day2Str}`);
  assert.ok(missed, 'a missed-check-in card is legitimate here');
  const followupsBefore = escFollowups(inboxBefore).length;

  // --- Day 2, benign reply. Yesterday's fall keeps the 72h assessment
  // elevated, but THIS message carries no adverse signal.
  const benign = await post('/api/chat', { senior_id: 'maggie', message: 'I did take my pills though.' });

  // Historical assessment is retained for journal/audit...
  assert.equal(benign.risk?.escalate, true, '72h assessment stays elevated from yesterday');
  assert.ok(benign.risk?.reasons?.some((r) => /fall/.test(r)));
  // ...but no NEW escalation is derived from it.
  assert.equal(benign.escalated, false);
  assert.ok(!benign.tool_calls.includes('notify_family'), 'no family card tool call');
  assert.ok(!benign.tool_calls.includes('schedule_followup'), 'no risk follow-up tool call');

  // Only the daily status card comes back, and it is truthful (calm).
  assert.equal(benign.cards.length, 1);
  assert.equal(benign.cards[0].kind, 'daily_status');
  assert.equal(benign.cards[0].severity, 'green');

  // The reply never implies this utterance was worrying and claims no note.
  assert.doesNotMatch(benign.reply, /worrying/i);
  assert.doesNotMatch(benign.reply, /left a note/i);
  assert.match(benign.reply, /Lovely to hear — medication taken/);
  assert.match(benign.reply, /Have a good day/);

  const inboxAfter = await get('/api/inbox?senior_id=maggie');
  // Card count/quote: yesterday's escalation card remains, unchanged...
  const escCards = escalationCards(inboxAfter);
  assert.equal(escCards.length, 1, 'no fresh escalation card was created');
  assert.equal(escCards[0].quote, "Oh... I fell yesterday. I'm fine, really.");
  assert.ok(!escCards[0].created_ts.startsWith(day2Str));
  // ...nothing quotes the benign meds confirmation as worrying...
  const benignQuoted = inboxAfter.cards.filter((c) => c.quote === 'I did take my pills though.');
  assert.equal(benignQuoted.length, 0, 'benign words must not be quoted on any family card');
  // ...no card body claims today's check-in was worrying...
  const day2Cards = inboxAfter.cards.filter((c) => c.created_ts.startsWith(day2Str));
  assert.ok(
    day2Cards.every((c) => !/mentioned something worrying in today's check-in/.test(c.body)),
    'no card may claim today\'s check-in was worrying'
  );
  // ...and no new risk follow-up was scheduled.
  assert.equal(escFollowups(inboxAfter).length, followupsBefore);

  // The legitimate missed-check-in card was resolved by the late reply.
  const resolved = inboxAfter.cards.find((c) => c.id === missed.id);
  assert.match(resolved.body, /no longer awaiting a reply/i);

  // Idempotent replay of the same benign message: still nothing new.
  const replay = await post('/api/chat', { senior_id: 'maggie', message: 'I did take my pills though.' });
  assert.equal(replay.escalated, false);
  const inboxReplay = await get('/api/inbox?senior_id=maggie');
  assert.equal(escalationCards(inboxReplay).length, 1);
  assert.equal(escFollowups(inboxReplay).length, followupsBefore);

  // --- Control, same day: an ACTUAL current risk must still escalate.
  const fallAgain = await post('/api/chat', { senior_id: 'maggie', message: 'Oh... I fell again just now.' });
  assert.equal(fallAgain.escalated, true);
  assert.match(fallAgain.reply, /sounds worrying/);
  assert.match(fallAgain.reply, /emergency number/);
  const newCard = fallAgain.cards.find((c) => String(c.dedupe_key || '').startsWith('escalation:'));
  assert.ok(newCard, 'current risk must create a fresh escalation card');
  assert.equal(newCard.severity, 'amber');
  assert.equal(newCard.quote, 'Oh... I fell again just now.');
  assert.match(newCard.body, /mentioned something worrying in today's check-in/);
  const inboxControl = await get('/api/inbox?senior_id=maggie');
  assert.equal(escalationCards(inboxControl).length, 2);
  assert.equal(escFollowups(inboxControl).length, followupsBefore + 1);
  assert.equal(escCompleted().length, 2, 'a genuinely new fall records exactly one new completion event');
});

test('explicit missed meds / low mood next day still escalate with truthful wording', async () => {
  // The day-2 "fell again just now" keeps the 72h assessment elevated.
  const state0 = await get('/api/state');
  const day3 = new Date(state0.clock_now);
  day3.setUTCDate(day3.getUTCDate() + 1);
  day3.setUTCHours(9, 50, 0, 0);
  await post('/api/demo/advance', { to_iso: day3.toISOString() });

  // Self-reported missed medication: accumulation escalates, but the card and
  // the companion say what was actually said — not "something worrying".
  const meds = await post('/api/chat', {
    senior_id: 'maggie',
    message: "I'm sorry, I forgot to take my pills this morning.",
  });
  assert.equal(meds.facts.meds_taken, false);
  assert.equal(meds.escalated, true);
  const medsCard = meds.cards.find((c) => String(c.dedupe_key || '').startsWith('escalation:'));
  assert.ok(medsCard);
  assert.equal(medsCard.quote, "I'm sorry, I forgot to take my pills this morning.");
  assert.match(medsCard.body, /medication was not taken/);
  assert.doesNotMatch(medsCard.body, /something worrying/);
  assert.match(meds.reply, /left a note for Dana \(daughter\)/);
  assert.doesNotMatch(meds.reply, /sounds worrying/);

  // Low mood: same truthful-wording guarantee.
  const low = await post('/api/chat', { senior_id: 'maggie', message: 'I feel awful and lonely today.' });
  assert.ok(low.facts.mood < 0);
  assert.equal(low.escalated, true);
  const lowCard = low.cards.find((c) => String(c.dedupe_key || '').startsWith('escalation:'));
  assert.ok(lowCard);
  assert.equal(lowCard.quote, 'I feel awful and lonely today.');
  assert.match(lowCard.body, /sounded low in today's check-in/);
  assert.doesNotMatch(lowCard.body, /something worrying/);
  assert.doesNotMatch(low.reply, /sounds worrying/);
});
