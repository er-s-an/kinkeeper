import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createClock } from '../src/clock.js';

function fresh() {
  const store = createStore(':memory:');
  const clock = createClock(store);
  const seeded = clock.setTime(new Date('2026-10-06T08:55:00.000Z'));
  return { store, clock, seeded, offset: store.getConfig('clock_offset_ms') };
}

test('seed-style setTime and a 1500 minute fast-forward stay valid', () => {
  const { store, clock, seeded, offset } = fresh();
  const target = Date.parse('2026-10-06T08:55:00.000Z');
  assert.ok(Math.abs(seeded.getTime() - target) < 50);
  assert.match(offset, /^-?\d+$/);
  const forwarded = clock.advance(1500 * 60000);
  const delta = forwarded.getTime() - seeded.getTime();
  assert.ok(delta >= 1500 * 60000 && delta < 1500 * 60000 + 1000);
  assert.equal(Number.isFinite(Date.parse(clock.nowIso())), true);
  store.close();
});

test('invalid clock inputs do not change the stored offset', () => {
  const cases = [
    ['banana date', (clock) => clock.setTime(new Date('banana'))],
    ['invalid date object', (clock) => clock.setTime(new Date({}))],
    ['non-Date', (clock) => clock.setTime('2026-10-06T08:55:00.000Z')],
    ['out of range instant', (clock) => clock.setTime(new Date(8640000000000001))],
    ['Infinity ms', (clock) => clock.advance(Infinity)],
    ['NaN ms', (clock) => clock.advance(Number.NaN)],
    ['string ms', (clock) => clock.advance('60000')],
    ['boolean ms', (clock) => clock.advance(true)],
    ['unsafe finite ms', (clock) => clock.advance(1e20 * 60000)],
  ];
  for (const [name, fn] of cases) {
    const { store, clock, offset } = fresh();
    assert.throws(() => fn(clock), (err) => err?.code === 'CLOCK_INPUT', name);
    assert.equal(store.getConfig('clock_offset_ms'), offset, name);
    assert.equal(Number.isFinite(Date.parse(clock.nowIso())), true, name);
    store.close();
  }
});

test('a far valid demo date can be set and read back', () => {
  const { store, clock } = fresh();
  const edge = clock.setTime(new Date('9999-12-31T00:00:00.000Z'));
  assert.ok(Math.abs(edge.getTime() - Date.parse('9999-12-31T00:00:00.000Z')) < 50);
  assert.equal(Number.isFinite(Date.parse(clock.nowIso())), true);
  store.close();
});
