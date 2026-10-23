// Regression for the focus-restore scroll geometry (public/focus-scroll.js).
// Codex acceptance of the 38f repair found the focused Why toggle left wholly
// below the 375x800 viewport after "Follow up later" (y849.9-893.9) and after
// Mark as seen (y871.6-915.6): renderInbox aligned only the card box. These
// cases pin the exact reported measurements plus the desktop title case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusScrollDelta } from '../public/focus-scroll.js';

const close = (a, b) => Math.abs(a - b) < 0.001;

// Applies a delta the way window.scrollBy does: content moves up by delta.
const after = (v, delta) => v - delta;

test('375px follow-up-later: focused toggle below viewport scrolls fully into view', () => {
  // Exact post-38f acceptance measurements: masthead bottom 284.2, viewport
  // 800, card title correctly at 296.2, focused .why-toggle at 849.9-893.9.
  const m = { mastBottom: 284.2, viewBottom: 800, cardTop: 296.2, cardBottom: 1210, targetTop: 849.9, targetBottom: 893.9 };
  const delta = focusScrollDelta(m);
  assert.ok(delta > 0, 'must scroll down');
  assert.ok(after(m.targetBottom, delta) <= 800 - 8 + 0.001, 'toggle bottom inside viewport with padding');
  assert.ok(after(m.targetTop, delta) >= 284.2 + 8 - 0.001, 'toggle top still below masthead');
  // Minimum movement: scrolling one pixel less would leave the toggle cut off.
  assert.ok(close(delta, 893.9 - (800 - 8)), 'scrolls the minimum that reveals the toggle');
});

test('375px mark-as-seen: focused toggle below viewport scrolls fully into view', () => {
  const m = { mastBottom: 284.2, viewBottom: 800, cardTop: 296.2, cardBottom: 1230, targetTop: 871.6, targetBottom: 915.6 };
  const delta = focusScrollDelta(m);
  assert.ok(after(m.targetBottom, delta) <= 800 - 8 + 0.001);
  assert.ok(after(m.targetTop, delta) >= 284.2 + 8 - 0.001);
  assert.ok(close(delta, 915.6 - (800 - 8)));
});

test('toggle hidden under the sticky masthead scrolls up, not down', () => {
  const m = { mastBottom: 284, viewBottom: 800, cardTop: 200, cardBottom: 700, targetTop: 250, targetBottom: 294 };
  const delta = focusScrollDelta(m);
  assert.ok(delta < 0, 'must scroll up');
  assert.ok(after(m.targetTop, delta) >= 284 + 8 - 0.001);
  assert.ok(after(m.targetBottom, delta) <= 800 - 8 + 0.001);
});

test('desktop: visible toggle plus title under masthead reveals the title', () => {
  // Post-fa7e desktop finding: focused card top 11px, sticky area ended 225px.
  const m = { mastBottom: 225, viewBottom: 754, cardTop: 11, cardBottom: 620, targetTop: 400, targetBottom: 444 };
  const delta = focusScrollDelta(m);
  assert.ok(close(after(m.cardTop, delta), 225 + 8), 'card title lands just under the masthead');
  assert.ok(after(m.targetBottom, delta) <= 754 - 8 + 0.001, 'toggle stays inside the viewport');
  assert.ok(after(m.targetTop, delta) >= 225 + 8 - 0.001);
});

test('title reveal is skipped when it would push the toggle out of view', () => {
  const m = { mastBottom: 225, viewBottom: 500, cardTop: 100, cardBottom: 490, targetTop: 420, targetBottom: 480 };
  const delta = focusScrollDelta(m);
  assert.equal(delta, 0, 'focused control already visible; revealing the title would hide it');
});

test('fully visible card and toggle never scroll', () => {
  const m = { mastBottom: 225, viewBottom: 754, cardTop: 240, cardBottom: 700, targetTop: 500, targetBottom: 544 };
  assert.equal(focusScrollDelta(m), 0);
});

test('control taller than the visible band keeps its top under the masthead', () => {
  const m = { mastBottom: 100, viewBottom: 300, cardTop: 50, cardBottom: 600, targetTop: 120, targetBottom: 500 };
  const delta = focusScrollDelta(m);
  assert.ok(after(m.targetTop, delta) >= 100 + 8 - 0.001);
});

test('card fallback (no control inside) keeps prior title alignment', () => {
  // Title tucked under the masthead.
  let delta = focusScrollDelta({ mastBottom: 225, viewBottom: 754, cardTop: 11, cardBottom: 620, targetTop: 11, targetBottom: 620, isCardTarget: true });
  assert.ok(close(after(11, delta), 225 + 12));
  // Fully visible card: no scroll.
  delta = focusScrollDelta({ mastBottom: 225, viewBottom: 754, cardTop: 240, cardBottom: 700, targetTop: 240, targetBottom: 700, isCardTarget: true });
  assert.equal(delta, 0);
});
