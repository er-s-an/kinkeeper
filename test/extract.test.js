import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts } from '../src/extract.js';

test('extracts sleep, meds and activity from a normal check-in', () => {
  const f = extractFacts('I slept 7 hours, took my meds, and walked the dog. Feeling good.', ['knee']);
  assert.equal(f.sleep_hours, 7);
  assert.equal(f.meds_taken, true);
  assert.ok(f.activities.includes('walk'));
  assert.ok(f.activities.includes('dog'));
  assert.equal(f.risk_flags.length, 0);
  assert.equal(f.mood, 1);
  assert.equal(f.vague, false);
});

test('detects fall as a risk flag', () => {
  const f = extractFacts("Oh... I fell yesterday in the kitchen. I'm fine, really.", ['knee']);
  assert.ok(f.risk_flags.includes('fall'));
  assert.equal(f.vague, true); // short, trailing, hedged
});

test('maps watched concerns to topics', () => {
  const f = extractFacts('My knee has been hurting since yesterday.', ['knee', 'medication']);
  assert.ok(f.topics.includes('knee'));
  assert.ok(!f.topics.includes('medication'));
  assert.ok(f.risk_flags.includes('pain'));
});

test('missing information stays null, never invented', () => {
  const f = extractFacts('Hello there.', []);
  assert.equal(f.sleep_hours, null);
  assert.equal(f.meds_taken, null); // tri-state: not mentioned at all
  assert.equal(f.meds_mentioned, false);
  assert.deepEqual(f.activities, []);
});

test('negated medication is not taken: "I had not taken my meds today."', () => {
  const f = extractFacts('I had not taken my meds today.', ['medication']);
  assert.equal(f.meds_taken, false); // explicitly NOT taken — not a false positive
  assert.equal(f.meds_mentioned, true);
  assert.equal(f.risk_flags.length, 0); // no invented risk either
  assert.equal(f.mood, 0); // no false wellness assertion
});

test('negated risks produce no flags: "I did not fall and I have no chest pain."', () => {
  const f = extractFacts('I did not fall and I have no chest pain.', []);
  assert.deepEqual(f.risk_flags, []);
  assert.ok(f.negated_flags.includes('fall'));
  assert.ok(f.negated_flags.includes('pain'));
  assert.ok(f.negated_flags.includes('chest'));
  assert.equal(f.mood, 0); // denied risks must not lower mood
});

test('positive medication is taken: "I did take my pills though."', () => {
  const f = extractFacts('I did take my pills though.', ['medication']);
  assert.equal(f.meds_taken, true);
  assert.equal(f.meds_mentioned, true);
});

test('seed day-2 transcript: pills taken despite the trailing "though"', () => {
  const f = extractFacts(
    "I'm okay I suppose. My knee has been hurting a bit since yesterday. Only slept 5 hours. I did take my pills though.",
    ['knee', 'medication', 'sleep']
  );
  assert.equal(f.meds_taken, true);
  assert.equal(f.sleep_hours, 5);
  assert.ok(f.risk_flags.includes('pain')); // the knee really hurts
});

test('negation is clause-scoped: "I fell but I have no pain."', () => {
  const f = extractFacts('I fell but I have no pain.', []);
  assert.ok(f.risk_flags.includes('fall')); // the fall is real
  assert.ok(!f.risk_flags.includes('pain')); // the pain is denied
  assert.ok(f.negated_flags.includes('pain'));
});

test('negation does not leak across clauses: "I have no pain and I fell."', () => {
  const f = extractFacts('I have no pain and I fell.', []);
  assert.ok(f.risk_flags.includes('fall'));
  assert.ok(!f.risk_flags.includes('pain'));
});

test('forgotten medication counts as not taken', () => {
  const f = extractFacts('I forgot my pills this morning.', ['medication']);
  assert.equal(f.meds_taken, false);
});

test('meds mentioned without a take cue stay unknown', () => {
  const f = extractFacts('My pills are on the kitchen table.', ['medication']);
  assert.equal(f.meds_taken, null);
  assert.equal(f.meds_mentioned, true);
});

test('negated sentiment is not a wellness assertion: "I am not good today."', () => {
  const f = extractFacts('I am not good today.', []);
  assert.equal(f.mood, 0); // "good" is negated — no false positive mood
});

test('a later affirmed fall survives an earlier negation', () => {
  const f = extractFacts('I did not fall yesterday, but I fell today.', []);
  assert.ok(f.risk_flags.includes('fall'));
  assert.ok(!f.negated_flags.includes('fall'));
  assert.equal(f.mood, -1);
});

test('reversed order still keeps the affirmed fall', () => {
  const f = extractFacts('I fell today, but I did not fall yesterday.', []);
  assert.ok(f.risk_flags.includes('fall'));
  assert.ok(!f.negated_flags.includes('fall'));
});

test('all-negated falls stay negated', () => {
  const f = extractFacts('I did not fall yesterday and I did not fall today.', []);
  assert.deepEqual(f.risk_flags, []);
  assert.ok(f.negated_flags.includes('fall'));
  assert.equal(f.mood, 0);
});

test('a second occurrence outside the negation window is kept in the same clause', () => {
  const f = extractFacts('I did not fall yesterday morning, I fell today.', []);
  assert.ok(f.risk_flags.includes('fall'));
  assert.ok(!f.negated_flags.includes('fall'));
});

test('a later keyword still inside the negation window is not invented as a fall', () => {
  // No clause boundary, and "not" is still within 4 words of the second "fell".
  const f = extractFacts('I did not fall yesterday I fell today.', []);
  assert.deepEqual(f.risk_flags, []);
  assert.ok(f.negated_flags.includes('fall'));
});

test('double negation is not rewritten into an affirmed fall', () => {
  const f = extractFacts("I didn't not fall.", []);
  assert.deepEqual(f.risk_flags, []);
  assert.ok(f.negated_flags.includes('fall'));
});

test('mixed chest pain keeps the affirmed mention', () => {
  const f = extractFacts('I have no chest pain, but my chest hurts today.', []);
  assert.ok(f.risk_flags.includes('chest'));
  assert.ok(f.risk_flags.includes('pain'));
  assert.ok(!f.negated_flags.includes('chest'));
  assert.ok(!f.negated_flags.includes('pain'));
});

test('a later affirmed walk survives an earlier negation', () => {
  const denied = extractFacts('I did not walk yesterday and I did not walk today.', []);
  assert.deepEqual(denied.activities, []);
  const mixed = extractFacts('I did not walk yesterday, but I walked today.', []);
  assert.ok(mixed.activities.includes('walk'));
});

test('bare or/nor repetitions retain the preceding denial beyond the word window', () => {
  for (const [text, flag] of [
    ['I did not fall at any point yesterday or fall at all today.', 'fall'],
    ['I did not fall at any point yesterday nor fall at all today.', 'fall'],
    ['I have no pain in my knee, no pain in my back, or pain anywhere else.', 'pain'],
  ]) {
    const facts = extractFacts(text);
    assert.deepEqual(facts.risk_flags, [], text);
    assert.ok(facts.negated_flags.includes(flag), text);
  }
});

test('an explicit subject after or starts an independent affirmation', () => {
  for (const text of [
    'I did not fall yesterday or I fell today.',
    'I did not fall or I fell.',
  ]) {
    const facts = extractFacts(text);
    assert.ok(facts.risk_flags.includes('fall'), text);
    assert.ok(!facts.negated_flags.includes('fall'), text);
  }
});

test('bare coordinated activities do not become affirmative beyond the word window', () => {
  const facts = extractFacts('I did not walk at any point yesterday or walk at all today.');
  assert.deepEqual(facts.activities, []);
});
