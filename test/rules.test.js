import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMissedCheckin, evaluateRepeatedTopics, scheduledCheckinIso } from '../src/rules.js';

const senior = {
  id: 'maggie',
  display_name: 'Maggie Rivera',
  checkin_time: '09:00',
  grace_minutes: 45,
  concerns: ['knee'],
  family_contact: 'Dana (daughter)',
};

const checkinOn = (date) => ({
  id: 1,
  ts: `${date}T09:05:00.000Z`,
  senior_id: 'maggie',
  type: 'checkin_recorded',
  payload: { date, facts: { topics: [] } },
});

test('R1: no action before scheduled time', () => {
  const actions = evaluateMissedCheckin({
    senior,
    checkinEvents: [],
    nowIso: '2026-10-04T08:30:00.000Z',
  });
  assert.deepEqual(actions, []);
});

test('R1: proactive prompt after scheduled time, amber card only after grace', () => {
  const before = evaluateMissedCheckin({
    senior,
    checkinEvents: [],
    nowIso: '2026-10-04T09:30:00.000Z',
  });
  assert.equal(before.length, 1);
  assert.equal(before[0].kind, 'proactive');

  const after = evaluateMissedCheckin({
    senior,
    checkinEvents: [],
    nowIso: '2026-10-04T09:50:00.000Z',
  });
  const card = after.find((a) => a.kind === 'card');
  assert.ok(card, 'expected an amber card after grace deadline');
  assert.equal(card.severity, 'amber');
  assert.equal(card.dedupe_key, 'card:missed:2026-10-04');
  assert.match(card.suggested_action, /call/i);
});

test('R1: no action when a check-in exists for today', () => {
  const actions = evaluateMissedCheckin({
    senior,
    checkinEvents: [checkinOn('2026-10-04')],
    nowIso: '2026-10-04T10:00:00.000Z',
  });
  assert.deepEqual(actions, []);
});

test('R1: deterministic — identical inputs give identical outputs', () => {
  const ctx = { senior, checkinEvents: [], nowIso: '2026-10-04T09:50:00.000Z' };
  assert.deepEqual(evaluateMissedCheckin(ctx), evaluateMissedCheckin(ctx));
});

test('R3: topic on >=3 distinct days produces an info card', () => {
  const events = ['2026-10-01', '2026-10-02', '2026-10-03'].map((d, i) => ({
    id: i + 1,
    ts: `${d}T09:05:00.000Z`,
    senior_id: 'maggie',
    type: 'checkin_recorded',
    payload: { date: d, facts: { topics: ['knee'] } },
  }));
  const actions = evaluateRepeatedTopics({
    senior,
    checkinEvents: events,
    nowIso: '2026-10-04T09:50:00.000Z',
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].severity, 'info');
  assert.match(actions[0].title, /knee/);
});

test('R3: topic on only 2 days stays silent', () => {
  const events = ['2026-10-02', '2026-10-03'].map((d, i) => ({
    id: i + 1,
    ts: `${d}T09:05:00.000Z`,
    senior_id: 'maggie',
    type: 'checkin_recorded',
    payload: { date: d, facts: { topics: ['knee'] } },
  }));
  const actions = evaluateRepeatedTopics({
    senior,
    checkinEvents: events,
    nowIso: '2026-10-04T09:50:00.000Z',
  });
  assert.deepEqual(actions, []);
});

test('scheduledCheckinIso composes the daily deadline', () => {
  assert.equal(scheduledCheckinIso('2026-10-04', '09:00'), '2026-10-04T09:00:00.000Z');
});
