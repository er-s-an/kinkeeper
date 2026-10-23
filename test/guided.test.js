// Unit check for the Explore-step gating predicate: the guided "Maggie
// answers vaguely about a fall" step must complete only for a newly
// escalated, vague, CURRENT fall mention — not for other true escalations
// (missed meds, low mood) that happen to share the `escalated` flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVagueFallEscalation } from '../public/guided.js';

test('newly escalated vague current fall completes the step', () => {
  assert.equal(
    isVagueFallEscalation({
      escalated: true,
      facts: { risk_flags: ['fall'], vague: true, mood: 0, meds_taken: null },
    }),
    true
  );
});

test('escalated missed-meds message does not complete the fall step', () => {
  assert.equal(
    isVagueFallEscalation({
      escalated: true,
      facts: { risk_flags: [], vague: false, mood: 0, meds_taken: false },
    }),
    false
  );
});

test('escalated vague low-mood message does not complete the fall step', () => {
  assert.equal(
    isVagueFallEscalation({
      escalated: true,
      facts: { risk_flags: [], vague: true, mood: -2, meds_taken: null },
    }),
    false
  );
});

test('escalated but non-vague fall mention does not complete the step', () => {
  assert.equal(
    isVagueFallEscalation({
      escalated: true,
      facts: { risk_flags: ['fall'], vague: false, mood: -1, meds_taken: null },
    }),
    false
  );
});

test('vague fall mention without a new escalation does not complete the step', () => {
  assert.equal(
    isVagueFallEscalation({
      escalated: false,
      facts: { risk_flags: ['fall'], vague: true, mood: -1, meds_taken: null },
    }),
    false
  );
});

test('missing or partial payloads never throw and never complete the step', () => {
  assert.equal(isVagueFallEscalation(null), false);
  assert.equal(isVagueFallEscalation({}), false);
  assert.equal(isVagueFallEscalation({ escalated: true }), false);
  assert.equal(isVagueFallEscalation({ escalated: true, facts: { risk_flags: 'fall', vague: true } }), false);
});
