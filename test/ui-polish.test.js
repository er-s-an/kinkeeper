// Regression guards for the 2026-10-04 UI/a11y polish:
//  1. --muted must keep WCAG AA (>= 4.5:1) on every surface token it is
//     used on (it computed 4.20:1 on --paper and 4.39:1 on --surface-soft
//     as #7a7260 — see submission/readiness-checklist.md section 5).
//  2. Unsupported speech controls must carry a persistent, visible
//     explanation wired with aria-describedby, not a hover-only title —
//     placed inside the chat head, directly under the buttons, so the
//     caption is visible at the point of interaction at 375 x 800 (the old
//     padded note below the header sat at y791-899, below the viewport).
//  3. The zero-count tab badge (12 px text on --line) must keep >= 4.5:1:
//     --muted on --line was only 3.69:1, so the badge uses --ink-soft
//     (5.34:1) without darkening every muted text in the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');

function token(name) {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(m, `--${name} token exists`);
  return m[1].toLowerCase();
}

function luminance(hex) {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

test('--muted meets 4.5:1 on every surface it renders on', () => {
  const muted = token('muted');
  // Cards/surfaces, the paper masthead + body, acknowledged cards, badges,
  // and the status-hero gradient tints behind .status-next.
  const surfaces = [
    'paper',
    'paper-deep',
    'surface',
    'surface-soft',
    'amber-soft',
    'green-soft',
    'info-soft',
    'teal-soft',
  ];
  for (const name of surfaces) {
    const ratio = contrast(muted, token(name));
    assert.ok(ratio >= 4.5, `--muted on --${name} is ${ratio.toFixed(2)}:1 (needs >= 4.5:1)`);
  }
});

test('unsupported speech state has a persistent visible note wired by aria-describedby', () => {
  assert.match(html, /<p class="speech-note" id="speech-note" hidden><\/p>/, 'note element exists');
  assert.equal(html.match(/class="speech-note"/g).length, 1, 'exactly one speech note in the page');
  // The note sits inside the chat head, directly under the buttons it
  // describes, so it is visible in the same viewport as the controls.
  assert.ok(
    html.indexOf('id="speech-note"') > html.indexOf('class="chat-head-actions"') &&
      html.indexOf('id="speech-note"') < html.indexOf('id="chat"'),
    'note is inside the chat head, between the speech buttons and the chat log'
  );
  const describedBy = app.match(/setAttribute\('aria-describedby', 'speech-note'\)/g) || [];
  assert.equal(describedBy.length, 2, 'both mic and voice buttons reference the note');
  assert.ok(app.includes('speechNote.hidden = false'), 'note is shown persistently, not auto-hidden');
  const ariaDisabled = app.match(/setAttribute\('aria-disabled', 'true'\)/g) || [];
  assert.equal(ariaDisabled.length, 2, 'both controls keep aria-disabled semantics');
});

test('zero-count tab badge keeps >= 4.5:1 for its actual foreground/background pair', () => {
  const rule = css.match(/\.tab-badge\.zero\s*\{([^}]*)\}/);
  assert.ok(rule, '.tab-badge.zero rule exists');
  const pick = (prop) => {
    const m = rule[1].match(new RegExp(`${prop}:\\s*var\\(--([a-z-]+)\\)`));
    assert.ok(m, `.tab-badge.zero ${prop} is a design token`);
    return token(m[1]);
  };
  const fg = pick('color');
  const bg = pick('background');
  assert.equal(bg, token('line'), 'badge background is still --line');
  const ratio = contrast(fg, bg);
  assert.ok(ratio >= 4.5, `zero badge ${fg} on ${bg} is ${ratio.toFixed(2)}:1 (needs >= 4.5:1)`);
});

test('320 px header lets its title wrap and reserves both speech targets', () => {
  const narrow = css.match(/@media \(max-width: 360px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(narrow, 'narrow override does not alter the accepted 375 px header');
  assert.match(narrow[1], /\.chat-head-row\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*flex-start;/);
  assert.match(narrow[1], /\.chat-head h2\s*\{[^}]*min-width:\s*0;[^}]*white-space:\s*normal;/);
  assert.match(narrow[1], /\.chat-head-actions\s*\{[^}]*flex-shrink:\s*0;/);
});
