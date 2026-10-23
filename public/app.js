/* ==========================================================================
   KinKeeper — care thread (frontend only)
   Talks to the local demo REST API; renders Maggie's Today view, Dana's
   Family updates, Safety, and the optional scenario explorer.
   No external resources; voice output via speechSynthesis (opt-in),
   dictation via webkitSpeechRecognition when the browser offers it.
   ========================================================================== */

import { isVagueFallEscalation } from './guided.js';
import { focusScrollDelta } from './focus-scroll.js';

const SENIOR_ID = 'maggie';

/* ----------------------------------------------------------- dom helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const fmtClock = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
};

const fmtDay = (dateStr) =>
  new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });

const fmtTimeShort = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* keep the HTTP status message */ }
    throw new Error(message);
  }
  return res.json();
}

/* ----------------------------------------------------- inline errors ----- */
function showInlineError(id, message) {
  const node = $(id);
  if (!node) return;
  node.textContent = message;
  node.hidden = !message;
}

/* ------------------------------------------------- screen-reader announce */
const announcer = el('div', 'sr-only');
announcer.setAttribute('aria-live', 'polite');
announcer.setAttribute('role', 'status');
document.body.appendChild(announcer);

function announce(message) {
  // Clear then set so a repeated identical message is still announced once.
  announcer.textContent = '';
  requestAnimationFrame(() => { announcer.textContent = message; });
}

/* --------------------------------------------------------------- toasts */
const toasts = el('div', 'toasts');
toasts.setAttribute('aria-hidden', 'true'); // announcements go through `announce`
document.body.appendChild(toasts);

function toast(message, kind = '', ms = 4200) {
  const t = el('div', `toast ${kind}`.trim(), message);
  toasts.appendChild(t);
  announce(message);
  setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

/* ------------------------------------------------------------ app state */
const state = {
  senior: null,          // seniors[0] from /api/state
  voiceOn: false,        // voice output is opt-in
  proactiveSeen: new Set(),
  guidedDone: new Set(),
  busy: false,
  rec: null,             // active SpeechRecognition
  proactiveBusy: false,
  lastCardIds: new Set(),
  focusCardAfterRender: null,
  whyOpen: new Set(),    // card ids whose "Why this card?" panel is expanded
  digestLoaded: false,
  journalLoaded: false,
};

/* ----------------------------------------------------------------- icons */
const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 12.5 5 5L20 6.5"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6.2a5 5 0 1 1 7.5 6.4z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5V8"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
};

/* ------------------------------------------------------------------ voice */
const canSpeak = typeof window.speechSynthesis !== 'undefined' &&
  typeof window.SpeechSynthesisUtterance !== 'undefined';

function setSpeaking(on) {
  for (const dot of document.querySelectorAll('.msg-companion .thread-dot')) {
    dot.closest('.msg-companion').classList.toggle('speaking', Boolean(on));
  }
}

function speak(text) {
  if (!state.voiceOn || !canSpeak) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    u.pitch = 1.05;
    setSpeaking(true);
    const done = () => setSpeaking(false);
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
    setTimeout(() => {
      try {
        if (!window.speechSynthesis.speaking) setSpeaking(false);
      } catch { setSpeaking(false); }
    }, Math.min(12000, text.length * 130) + 800);
  } catch {
    setSpeaking(false); // voice output is decorative — never break the demo
  }
}

function pulseForReply(msgNode) {
  if (!msgNode || reducedMotion.matches) return;
  msgNode.classList.add('speaking');
  setTimeout(() => {
    try {
      if (!window.speechSynthesis?.speaking) msgNode.classList.remove('speaking');
    } catch { msgNode.classList.remove('speaking'); }
  }, 1600);
}

/* ------------------------------------------------------------------ chat */
const chat = $('#chat');
const chatInput = $('#chat-input');
const sendBtn = $('#send-btn');
const sendLabel = $('#send-label');
const composer = $('#composer');

function scrollChat() {
  chat.scrollTop = chat.scrollHeight;
}

function addUserMessage(text, meta = '') {
  const msg = el('div', 'msg msg-user msg-enter-right');
  const bubble = el('div', 'bubble');
  bubble.textContent = text;
  if (meta) bubble.appendChild(el('span', 'msg-meta', meta));
  msg.appendChild(bubble);
  chat.appendChild(msg);
  scrollChat();
}

function addCompanionShell({ proactive = false, kind = '' } = {}) {
  const msg = el('div', 'msg msg-companion msg-enter-left');
  const dot = el('span', 'thread-dot');
  dot.setAttribute('aria-hidden', 'true');
  dot.innerHTML = ICONS.heart;
  msg.appendChild(dot);
  const col = el('div', 'companion-col');
  col.style.cssText = 'min-width:0;flex:1';
  if (proactive) {
    const tag = el('span', 'proactive-tag');
    tag.textContent = kind === 'risk_followup'
      ? 'KinKeeper is checking back in'
      : 'KinKeeper spoke first';
    col.appendChild(tag);
    msg.classList.add('new-prompt');
  }
  const bubble = el('div', 'bubble');
  col.appendChild(bubble);
  msg.appendChild(col);
  chat.appendChild(msg);
  scrollChat();
  return { msg, col, bubble };
}

/* A status / escalation / digest card. Handles both daily cards (lines[])
   and escalation cards (body, quote, suggested_action). */
const SEVERITY_LABEL = { green: 'Calm', amber: 'Needs attention', info: 'Update' };

function renderCard(card = {}) {
  const sev = ['green', 'amber', 'info'].includes(card.severity) ? card.severity : 'info';
  const box = el('div', `kk-card ${sev}`);
  const head = el('div', 'kk-card-head');
  head.appendChild(el('span', `badge ${sev}`, SEVERITY_LABEL[sev]));
  head.appendChild(el('span', 'kk-card-title', card.title || 'Card'));
  box.appendChild(head);

  if (Array.isArray(card.lines) && card.lines.length) {
    const ul = el('ul');
    for (const line of card.lines) ul.appendChild(el('li', '', line));
    box.appendChild(ul);
  }
  if (card.body) box.appendChild(el('div', 'kk-card-body', cardBodyText(card)));
  if (card.quote) {
    const q = el('div', 'quote');
    q.appendChild(el('span', 'sr-only', 'Maggie said: '));
    q.appendChild(document.createTextNode(card.quote));
    box.appendChild(q);
  }
  if (card.suggested_action) {
    const s = el('div', 'suggested');
    s.innerHTML = `<strong>Suggested:</strong> ${escapeHtml(card.suggested_action)}`;
    box.appendChild(s);
  }
  return box;
}

function finishCompanionTurn(col, { cards = [], recall = [] }) {
  const extras = el('div', 'msg-extras');
  for (const r of recall) extras.appendChild(el('div', 'recall-line', r.line));
  for (const card of cards) extras.appendChild(renderCard(card));
  if (extras.children.length) col.appendChild(extras);
  scrollChat();
}

/* ------------------------------------------------------------ sending chat */
async function sendChat(text) {
  const message = (text ?? chatInput.value).trim();
  if (!message || state.busy) return;
  state.busy = true;
  sendBtn.disabled = true;
  sendLabel.textContent = 'Sending…';
  showInlineError('#composer-error', '');
  addUserMessage(message, fmtClock(state.senior?.clockNow || new Date().toISOString()));
  chatInput.value = '';
  try {
    // The mutation and the post-mutation refresh are separate failure domains:
    // a lost POST is ambiguous (the server may have recorded the words before
    // the answer was lost), while a failure AFTER a server answer means the
    // words were definitely saved. The two must never share one error text.
    let r;
    try {
      r = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ senior_id: SENIOR_ID, message }),
      });
    } catch (err) {
      // Honest uncertainty instead of a false "not recorded" claim. Resending
      // the exact same words is the safe recovery: the server's idempotency
      // key (same senior, same day, same words) never double-records.
      showInlineError('#composer-error',
        `KinKeeper could not confirm the message was saved (${err.message}). Sending the exact same words again is safe — the same check-in is never recorded twice.`);
      addCompanionShell(false).bubble.textContent =
        'Sorry — my memory did not answer, so I cannot confirm your words were saved. Sending the exact same words again is safe: I never record the same check-in twice.';
      return;
    }
    try {
      const shell = addCompanionShell(false);
      shell.bubble.textContent = r.reply || '…';
      finishCompanionTurn(shell.col, r);
      pulseForReply(shell.msg);
      speak(r.reply || '');
      announce(`KinKeeper replied: ${r.reply || ''}`);
      if (Array.isArray(r.cards) && r.cards.some((c) => c?.severity === 'green')) {
        markStepDone('checkin');
      }
      if (r.escalated) {
        toast('Worrying words heard — a card is waiting in Family updates.', 'ok');
      }
      // The guided "vague about a fall" step completes only for the moment its
      // copy describes — a newly escalated, vague CURRENT fall mention. Any
      // other true escalation (missed meds, low mood) still gets the toast
      // above but must not check off this specific step.
      if (isVagueFallEscalation(r)) {
        markStepDone('fall');
      }
      await refreshState();
      refreshInbox(false);
      if (state.journalLoaded) refreshJournal(false);
    } catch (err) {
      // The server answered, so the words ARE recorded; only the on-page
      // refresh/render failed. Say so — never tell the user to resend.
      showInlineError('#composer-error',
        `Your words were saved, but this page could not refresh (${err.message}). Reload the page to see the latest state — please do not send the message again.`);
    }
  } finally {
    state.busy = false;
    sendBtn.disabled = false;
    sendLabel.textContent = 'Send';
    chatInput.focus();
  }
}

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  sendChat();
});

$('#suggestions').addEventListener('click', (e) => {
  const chip = e.target.closest('.suggestion');
  if (chip) prefill(chip.dataset.text);
});

function prefill(text) {
  chatInput.value = text;
  chatInput.focus();
  chatInput.setSelectionRange(text.length, text.length);
}

/* --------------------------------------------------------- voice controls */
const voiceBtn = $('#voice-btn');
function updateVoiceBtn() {
  voiceBtn.classList.toggle('is-on', state.voiceOn);
  voiceBtn.setAttribute('aria-pressed', String(state.voiceOn));
  voiceBtn.title = state.voiceOn
    ? 'Voice output on — KinKeeper reads replies aloud'
    : 'Voice output is off — turn it on to have KinKeeper read replies aloud';
}
voiceBtn.addEventListener('click', () => {
  if (!canSpeak) return; // inert; explained at boot
  state.voiceOn = !state.voiceOn;
  if (!state.voiceOn) {
    try { window.speechSynthesis.cancel(); } catch { /* decorative */ }
    setSpeaking(false);
  }
  updateVoiceBtn();
  toast(state.voiceOn
    ? 'Voice output on — KinKeeper will read replies aloud.'
    : 'Voice output off.');
});

/* Dictation: use the Web Speech API when present, degrade gracefully. */
const micBtn = $('#mic-btn');
const micNote = $('#mic-note');
const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

function showMicNote(text, warn = false, ms = 6000) {
  micNote.textContent = text;
  micNote.classList.toggle('warn', warn);
  micNote.hidden = !text;
  if (text) announce(text);
  if (text && ms) {
    clearTimeout(showMicNote.t);
    showMicNote.t = setTimeout(() => { micNote.hidden = true; }, ms);
  }
}

micBtn.addEventListener('click', () => {
  if (!SR) return; // inert; explained at boot
  if (state.rec) {
    try { state.rec.stop(); } catch { /* already stopped */ }
    return;
  }
  try {
    const rec = new SR();
    state.rec = rec;
    rec.lang = 'en-US';
    rec.interimResults = false;
    micBtn.classList.add('is-on');
    showMicNote('Listening… speak now. You will be able to review the words before anything is sent.', false, 0);
    rec.onresult = (ev) => {
      const text = ev.results?.[0]?.[0]?.transcript || '';
      if (text.trim()) {
        // The transcript lands in the field for review — it is NOT auto-sent.
        prefill(text);
        showMicNote('Heard you — review the words in the message field, then press Send when they look right.');
      }
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        showMicNote('Microphone permission was denied — typing works exactly the same.', true);
      } else if (ev.error !== 'aborted') {
        showMicNote(`Voice input stopped (${ev.error}). You can type instead.`, true);
      }
    };
    rec.onend = () => {
      state.rec = null;
      micBtn.classList.remove('is-on');
      if (!micNote.classList.contains('warn')) micNote.hidden = true;
    };
    rec.start();
  } catch {
    state.rec = null;
    micBtn.classList.remove('is-on');
    showMicNote('Voice input isn’t supported in this browser — typing works exactly the same.', true);
  }
});

/* -------------------------------------------------------------- demo clock */
const clockEl = $('#clock');

function setClock(iso) {
  clockEl.textContent = fmtClock(iso);
}

async function refreshState() {
  try {
    const s = await api('/api/state');
    const senior = s.seniors?.[0];
    state.senior = senior ? { ...senior, clockNow: s.clock_now } : null;
    setClock(s.clock_now);
    renderStatusHero();
    renderInboxBadge(senior);
  } catch {
    renderStatusHeroOffline();
  }
}

/* ------------------------------------------------------------ status hero */
const heroEl = $('#status-hero');
const heroIcon = $('#status-icon');
const heroTitle = $('#status-title');
const heroDetail = $('#status-detail');
const heroNext = $('#status-next');
let lastHeroKind = '';

function setHero(kind, icon, title, detail, next) {
  heroEl.classList.remove('ok', 'attention', 'waiting');
  if (kind) heroEl.classList.add(kind);
  heroIcon.innerHTML = ICONS[icon] || ICONS.info;
  heroTitle.textContent = title;
  heroDetail.textContent = detail;
  heroNext.textContent = next || '';
  if (kind && kind !== lastHeroKind && !reducedMotion.matches) {
    heroEl.classList.remove('emphasize');
    void heroEl.offsetWidth; // restart the single emphasis
    heroEl.classList.add('emphasize');
  }
  lastHeroKind = kind;
}

function renderStatusHero() {
  const s = state.senior;
  if (!s) return;
  const name = s.display_name || 'Maggie';
  const nextText = `Next check-in is due at ${s.checkin_time || '09:00'} (demo time).`;
  if (s.checked_in_today) {
    const facts = s.last_checkin?.facts || {};
    if (facts.meds_taken === false) {
      setHero('attention', 'bell',
        'Today needs a little attention',
        `${name} checked in today, and in her own words said her medication was not taken. This describes what she said — it is not a medical assessment.`,
        nextText);
    } else if ((facts.risk_flags || []).length) {
      setHero('attention', 'bell',
        'Today needs a little attention',
        `${name} checked in today and mentioned ${facts.risk_flags.join(', ')} in her own words. This describes what she said — it is not a medical assessment.`,
        nextText);
    } else if ((facts.mood ?? 0) < 0) {
      // Same care facts as the daily card: a low-mood check-in is NEEDS
      // ATTENTION there, so the hero must not claim a calm day.
      setHero('attention', 'bell',
        'Today needs a little attention',
        `${name} checked in today and sounded low in her own words. This describes what she said — it is not a medical assessment.`,
        nextText);
    } else {
      setHero('ok', 'check',
        `${name} checked in today`,
        `Her check-in is recorded in today's journal. The conversation below is this visit's view; the journal keeps the lasting record.`,
        nextText);
    }
  } else {
    setHero('waiting', 'clock',
      `${name} has not checked in yet today`,
      `Her daily check-in is due at ${s.checkin_time || '09:00'} (demo time). Send her first message below — that is the one thing to do on this screen.`,
      '');
  }
}

function renderStatusHeroOffline() {
  setHero('attention', 'info',
    'KinKeeper is not reachable',
    'The demo server did not answer. Check that it is still running, then reload this page.',
    '');
}

function renderInboxBadge(senior) {
  const badge = $('#inbox-badge');
  const n = senior?.open_cards ?? 0;
  badge.hidden = false;
  badge.textContent = String(n);
  badge.classList.toggle('zero', n === 0);
}

/* ------------------------------------------------------------ time travel */
async function advanceMinutes(minutes) {
  const r = await api('/api/demo/advance', {
    method: 'POST',
    body: JSON.stringify({ minutes }),
  });
  setClock(r.now);
  await refreshState();
  return r;
}

function withControl(btn, fn) {
  return async () => {
    if (btn.disabled) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Moving the clock…';
    showInlineError('#controls-error', '');
    try {
      await fn();
    } catch (err) {
      // A failed clock move is ambiguous: the server may have moved the clock
      // before its answer was lost. Resync the display from the server, then
      // say what is known instead of claiming nothing changed.
      await refreshState();
      showInlineError('#controls-error',
        `The clock move could not be confirmed (${err.message}). The clock above now shows the server's actual time — check it before trying again.`);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  };
}

const advanceToNextMorning = withControl($('#btn-advance-morning'), async () => {
  const base = state.senior?.clockNow || new Date().toISOString();
  const now = new Date(base);
  const target = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9, 50,
  ));
  const minutes = Math.max(1, Math.round((target - now) / 60000));
  const r = await advanceMinutes(minutes);
  toast(`The demo clock moved to ${fmtClock(r.now)} — past Maggie's usual check-in time, so KinKeeper notices the quiet.`, 'ok', 6000);
  markStepDone('advance');
  await pollProactive(true);
  refreshInbox(false);
});

$('#btn-advance-morning').addEventListener('click', advanceToNextMorning);

$('#btn-advance-1h').addEventListener('click', withControl($('#btn-advance-1h'), async () => {
  const r = await advanceMinutes(60);
  toast(`The demo clock moved to ${fmtClock(r.now)}.`, 'ok');
  await pollProactive(true);
}));

/* ------------------------------------------------------------- weekly digest */
async function runDigest() {
  const btn = $('#btn-digest');
  if (btn.disabled) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  showInlineError('#digest-error', '');
  try {
    const d = await api('/api/digest', {
      method: 'POST',
      body: JSON.stringify({ senior_id: SENIOR_ID }),
    });
    renderDigest(d);
    state.digestLoaded = true;
    markStepDone('digest');
    announce('The weekly summary is ready.');
  } catch (err) {
    showInlineError('#digest-error',
      `The weekly summary could not be prepared (${err.message}). You can try again.`);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function renderDigest(d) {
  const wrap = $('#digest');
  wrap.innerHTML = '';
  const card = el('article', 'card digest-card');
  const head = el('div', 'kk-card-head');
  const hasRisk = (d.risk_days || []).length > 0;
  head.appendChild(el('span', `badge ${hasRisk ? 'amber' : 'green'}`, hasRisk ? 'Needs attention' : 'Calm'));
  head.appendChild(el('span', 'kk-card-title',
    `Week of ${d.period?.from ?? ''} to ${d.period?.to ?? ''}`));
  card.appendChild(head);

  const ul = el('ul', 'digest-lines');
  const addLine = (text, attention = false) => {
    const li = el('li', attention ? 'attention' : '', text);
    ul.appendChild(li);
  };
  addLine(`Maggie checked in on ${d.checkin_completion?.days_with_checkin ?? 0} of ${d.checkin_completion?.out_of ?? 7} days.`);
  if (d.mood_average != null) addLine(`Her average mood was ${d.mood_average} on a scale from −2 to +2.`);
  if ((d.recurring_topics || []).length) {
    addLine(`Topics that keep coming up: ${d.recurring_topics.map((t) => `“${t.topic}” (${t.days} days)`).join(', ')}.`);
  }
  if (hasRisk) {
    addLine(`Days with worrying words: ${(d.risk_days || []).map(fmtDay).join(', ')}.`, true);
  } else {
    addLine('No days with worrying words this week.');
  }
  card.appendChild(ul);

  for (const t of d.recurring_topics || []) {
    if (t.example_quote) {
      const q = el('div', 'recall-line',
        `On “${t.topic}”, Maggie's own words from the journal: “${t.example_quote}”`);
      card.appendChild(q);
    }
  }
  wrap.appendChild(card);
}

$('#btn-digest').addEventListener('click', runDigest);

/* ------------------------------------------------------------------ reset */
$('#btn-reset').addEventListener('click', async () => {
  const ok = window.confirm(
    'Start the demo over?\n\nThis clears the fictional journal and family cards, returns the demo clock to 8:55 on the first morning, and clears the conversation on this page.',
  );
  if (!ok) return;
  showInlineError('#controls-error', '');
  try {
    await api('/api/demo/reset', { method: 'POST', body: '{}' });
    resetLocalDemo();
    await refreshState();
    toast('The demo started over — a fresh three-day journal, clock back to 8:55.', 'ok');
  } catch (err) {
    showInlineError('#controls-error',
      `The demo restart could not be confirmed (${err.message}). Reload the page to see the current state before trying again.`);
  }
});

function resetLocalDemo() {
  chat.innerHTML = '';
  state.guidedDone.clear();
  state.proactiveSeen.clear();
  state.lastCardIds = new Set();
  state.digestLoaded = false;
  state.journalLoaded = false;
  $('#digest').innerHTML = '';
  renderDigestPlaceholder();
  for (const btn of document.querySelectorAll('.step.done')) btn.classList.remove('done');
  if (canSpeak) {
    try { window.speechSynthesis.cancel(); } catch { /* decorative */ }
  }
  setSpeaking(false);
  seedChatGreeting();
  refreshInbox(false);
  refreshJournal(false);
}

function seedChatGreeting() {
  const shell = addCompanionShell(false);
  shell.bubble.textContent =
    'Good morning. This is Maggie’s check-in with KinKeeper — type what she says below, ' +
    'or tap one of the suggestions. KinKeeper remembers each day in her journal and gently ' +
    'speaks first if a morning goes quiet. Keep it fictional — what you type is saved in ' +
    'this demo’s journal on this computer. Nothing is pushed to Dana, but worrying words ' +
    'appear as a card on the Family updates page inside this demo.';
}

/* -------------------------------------------------------------- proactive */
async function pollProactive(fromStep = false) {
  if (state.proactiveBusy) return;
  state.proactiveBusy = true;
  try {
    const r = await api(`/api/proactive?senior_id=${encodeURIComponent(SENIOR_ID)}`);
    if (r.prompt && !state.proactiveSeen.has(r.event_id)) {
      state.proactiveSeen.add(r.event_id);
      const shell = addCompanionShell({ proactive: true, kind: r.kind || '' });
      shell.bubble.textContent = r.prompt;
      pulseForReply(shell.msg);
      speak(r.prompt);
      announce(`KinKeeper spoke first: ${r.prompt}`);
      markStepDone('proactive');
      // The GET only peeks; confirm the prompt was actually displayed/spoken.
      api('/api/proactive/ack', {
        method: 'POST',
        body: JSON.stringify({ senior_id: SENIOR_ID, event_id: r.event_id }),
      }).catch(() => { /* ack is idempotent; next poll would retry it */ });
      refreshState();
    } else if (fromStep) {
      toast('KinKeeper has nothing to say first right now — try moving the clock past 9:45 in the morning first.');
    }
  } catch {
    // Polling must never surface errors — the demo keeps running.
  } finally {
    state.proactiveBusy = false;
  }
}

setInterval(() => pollProactive(false), 4000);

/* -------------------------------------------------------------------- tabs */
let activeTab = 'today';
const tabOrder = ['today', 'family', 'safety', 'explore'];

function switchTab(name, { focusTab = false } = {}) {
  if (name === activeTab) return;
  activeTab = name;
  for (const btn of document.querySelectorAll('.tab')) {
    const on = btn.dataset.tab === name;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    if (on && focusTab) btn.focus();
  }
  for (const panel of document.querySelectorAll('.panel')) {
    const on = panel.id === `panel-${name}`;
    panel.classList.toggle('is-active', on);
    panel.hidden = !on;
  }
  if (name === 'family') {
    markStepDone('inbox');
    refreshInbox(true);
    if (!state.digestLoaded) renderDigestPlaceholder();
  }
}

function renderDigestPlaceholder() {
  const wrap = $('#digest');
  if (wrap.children.length) return;
  wrap.appendChild(el('p', 'empty-note',
    'The weekly summary has not been prepared yet. Use “Refresh weekly summary” to gather Maggie’s week into a few plain lines.'));
}

const tabsNav = document.querySelector('.tabs');

tabsNav.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) switchTab(btn.dataset.tab);
});

tabsNav.addEventListener('keydown', (e) => {
  const current = document.activeElement.closest?.('.tab');
  if (!current) return;
  const idx = tabOrder.indexOf(current.dataset.tab);
  let next = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabOrder[(idx + 1) % tabOrder.length];
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = tabOrder[(idx - 1 + tabOrder.length) % tabOrder.length];
  else if (e.key === 'Home') next = tabOrder[0];
  else if (e.key === 'End') next = tabOrder[tabOrder.length - 1];
  if (next) {
    e.preventDefault();
    switchTab(next, { focusTab: true });
  }
});

$('#goto-family').addEventListener('click', () => switchTab('family', { focusTab: true }));

/* First-screen check-in action: scroll the composer into view and put the
   caret in the message field — the one primary action on Maggie's screen. */
$('#checkin-cta').addEventListener('click', () => {
  composer.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'center' });
  chatInput.focus({ preventScroll: true });
});

/* ------------------------------------------------------------- guided demo */
function markStepDone(name) {
  if (state.guidedDone.has(name)) return;
  state.guidedDone.add(name);
  const btn = document.querySelector(`.step[data-step="${name}"]`);
  if (btn) btn.classList.add('done');
}

$('#guided-steps').addEventListener('click', (e) => {
  const btn = e.target.closest('.step');
  if (!btn) return;
  const step = btn.dataset.step;
  if (step === 'checkin') {
    switchTab('today', { focusTab: true });
    prefill('Good morning! I slept about 6 hours, took my meds, and walked the dog.');
  } else if (step === 'advance') {
    $('#btn-advance-morning').click();
  } else if (step === 'proactive') {
    switchTab('today', { focusTab: true });
    toast('Listening for KinKeeper to speak first, for up to 15 seconds…', '', 3200);
    pollProactive(true);
  } else if (step === 'fall') {
    switchTab('today', { focusTab: true });
    prefill("Oh... I fell yesterday. I'm fine, really.");
  } else if (step === 'inbox') {
    switchTab('family', { focusTab: true });
  } else if (step === 'digest') {
    switchTab('family', { focusTab: true });
    runDigest();
  }
});

/* ------------------------------------------------------------- family inbox */
const inboxOpenEl = $('#inbox-open');
const inboxSeenEl = $('#inbox-seen');

function cardIcon(severity) {
  if (severity === 'amber') return 'bell';
  if (severity === 'green') return 'check';
  return 'info';
}

/* Plain-language source hints — engineering identifiers stay out of the UI.
   The backend stores source.via as "mcp:notify_family", so match the tool
   name with or without its transport prefix. An amber card must never fall
   through to a calm label like "A quiet morning". */
function cardKindLabel(card) {
  const src = card.source || {};
  const via = String(src.via || '');
  if (src.rule_id === 'R1_MISSED_CHECKIN') return 'A quiet morning';
  if (src.rule_id === 'R3_REPEATED_TOPIC' || src.topic) return 'A topic that keeps coming up';
  if (via === 'notify_family' || via.endsWith(':notify_family') || src.reasons) return 'Worrying words';
  return card.severity === 'amber' ? 'Needs a look' : 'An update';
}

/* Cards created before the product-wording repair may carry rule/scoring
   jargon in their body. Show humane wording instead; the technical detail
   remains in the backend audit trail, not on the card. */
const TECHNICAL_BODY = /deterministic rules|risk phrases|\(\+\d+\)/;

function cardBodyText(card) {
  const body = String(card.body || '');
  if (!TECHNICAL_BODY.test(body)) return body;
  return 'KinKeeper heard worrying words in this check-in — the exact message is quoted on this card. ' +
    'It repeats what was said and cannot tell how serious it is.';
}

// Dana's human next steps. The button names what she chooses; the timeline
// phrase states what she REPORTED — recording never places a call or sends
// anything. `firstName` is the senior's ("Maggie" in this demo).
const ACTION_LABELS = {
  plan_call: {
    button: () => 'Plan a call',
    timeline: (firstName) => `Dana plans to call ${firstName}`,
  },
  tried_call: {
    button: () => 'Tried to call',
    timeline: () => 'Dana said she tried to call',
  },
  reached: {
    button: (firstName) => `Reached ${firstName}`,
    timeline: (firstName) => `Dana said she reached ${firstName}`,
  },
  follow_up_later: {
    button: () => 'Follow up later',
    timeline: () => 'Dana will follow up on this later',
  },
};

function renderThreadCard(card, { isNew = false } = {}) {
  const acknowledged = card.status === 'acknowledged';
  const resolved = card.source?.resolved?.by === 'late_checkin';
  const box = el('article', `card thread-card ${card.severity}${acknowledged ? ' acknowledged' : ''}${isNew ? ' new-card' : ''}`);
  box.dataset.cardId = String(card.id);
  // Programmatically focusable: after Mark-as-seen reorders the card into the
  // seen section (where it has no button), keyboard focus lands back on it.
  box.tabIndex = -1;

  const dot = el('span', 'card-dot');
  dot.setAttribute('aria-hidden', 'true');
  dot.innerHTML = ICONS[cardIcon(card.severity)];
  box.appendChild(dot);

  const body = el('div', 'thread-card-body');
  const top = el('div', 'thread-card-top');
  top.appendChild(el('span', `badge ${card.severity}`, SEVERITY_LABEL[card.severity] || 'Update'));
  top.appendChild(el('span', 'kk-card-title', card.title));
  top.appendChild(el('span', 'card-ts', cardKindLabel(card)));
  body.appendChild(top);

  body.appendChild(el('div', 'kk-card-body', cardBodyText(card)));
  if (card.quote) {
    const q = el('div', 'quote');
    q.appendChild(el('span', 'sr-only', 'Maggie said: '));
    q.appendChild(document.createTextNode(card.quote));
    body.appendChild(q);
  }
  if (card.suggested_action) {
    const s = el('div', 'suggested');
    s.innerHTML = `<strong>Suggested:</strong> ${escapeHtml(card.suggested_action)}`;
    body.appendChild(s);
  }

  // The factual, chronological timeline from the server: created, Maggie's
  // reply if any, seen (with its real time), and Dana's recorded steps. It
  // stays current after late replies, marking seen, and page reloads.
  const firstName = (state.senior?.display_name || 'Maggie').split(' ')[0];
  const timeline = el('ul', 'card-timeline');
  for (const t of card.timeline || []) {
    if (t.kind === 'created') {
      timeline.appendChild(el('li', 'done', `Card created · ${fmtClock(t.ts)}`));
    } else if (t.kind === 'replied') {
      timeline.appendChild(el('li', 'done',
        `${firstName} replied · ${fmtClock(t.ts)} — KinKeeper is no longer awaiting a reply`));
    } else if (t.kind === 'seen') {
      timeline.appendChild(el('li', 'done',
        t.ts ? `Seen by family · ${fmtClock(t.ts)}` : 'Seen by family'));
    } else if (t.kind === 'action') {
      timeline.appendChild(el('li', 'done action',
        `${ACTION_LABELS[t.action]?.timeline(firstName) || t.action} · ${fmtClock(t.ts)}`));
    }
  }
  if (card.source?.rule_id === 'R1_MISSED_CHECKIN' && !resolved) {
    timeline.appendChild(el('li', 'pending', 'Awaiting Maggie’s reply'));
  }
  if (!acknowledged) {
    timeline.appendChild(el('li', 'pending', 'Not seen by family yet'));
  }
  body.appendChild(timeline);

  // Expandable plain-language evidence. Raw rule IDs, scores and audit rows
  // deliberately stay out — this explains the card in observed words and
  // times only.
  if (card.why) {
    const whyId = `why-${card.id}`;
    const toggle = el('button', 'why-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', whyId);
    const toggleIcon = el('span', 'why-icon');
    toggleIcon.setAttribute('aria-hidden', 'true');
    toggleIcon.innerHTML = ICONS.info;
    const toggleChevron = el('span', 'why-chevron');
    toggleChevron.setAttribute('aria-hidden', 'true');
    toggleChevron.innerHTML = ICONS.chevron;
    toggle.appendChild(toggleIcon);
    toggle.appendChild(el('span', '', 'Why this card?'));
    toggle.appendChild(toggleChevron);

    const panel = el('div', 'why-panel');
    panel.id = whyId;
    panel.hidden = true;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', `Why the card “${card.title}” exists`);
    if (card.why.summary) panel.appendChild(el('p', 'why-summary', card.why.summary));
    if (card.why.quote) {
      const q = el('div', 'quote');
      q.appendChild(el('span', 'sr-only', `${firstName} said: `));
      q.appendChild(document.createTextNode(card.why.quote));
      panel.appendChild(q);
    }
    if (card.why.facts?.length) {
      const ul = el('ul', 'why-list');
      for (const f of card.why.facts) ul.appendChild(el('li', '', f));
      panel.appendChild(ul);
    }
    if (card.why.context?.length) {
      panel.appendChild(el('p', 'why-context-label', 'From this week’s journal:'));
      const ul = el('ul', 'why-list');
      for (const c of card.why.context) ul.appendChild(el('li', '', c));
      panel.appendChild(ul);
    }
    // Expanded state survives the re-render that follows Mark as seen or a
    // recorded family step — the card is rebuilt from scratch, so the open
    // disclosure is tracked by card id and restored here.
    if (state.whyOpen.has(String(card.id))) {
      toggle.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
    }
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      panel.hidden = open;
      if (open) state.whyOpen.delete(String(card.id));
      else state.whyOpen.add(String(card.id));
    });
    body.appendChild(toggle);
    body.appendChild(panel);
  }

  const actions = el('div', 'card-actions');
  if (acknowledged) {
    const pill = el('span', 'seen-pill');
    pill.innerHTML = `${ICONS.check}<span>Seen by family</span>`;
    actions.appendChild(pill);
  } else {
    const b = el('button', 'btn btn-ghost btn-small ack-btn', 'Mark as seen');
    b.type = 'button';
    b.dataset.cardId = String(card.id);
    b.setAttribute('aria-label', `Mark “${card.title}” as seen`);
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      // Disabling the focused button drops keyboard focus to <body> at once,
      // so remember the card NOW; renderInbox restores focus to it after the
      // mark-as-seen reorder (the acknowledged card has no button anymore).
      state.focusCardAfterRender = String(card.id);
      b.disabled = true;
      b.textContent = 'Marking…';
      showInlineError('#inbox-error', '');
      try {
        await api(`/api/inbox/${card.id}/ack`, { method: 'POST', body: JSON.stringify({ senior_id: SENIOR_ID }) });
        if (!reducedMotion.matches) {
          box.classList.add('settling');
          await new Promise((res) => setTimeout(res, 260));
        }
        announce(`“${card.title}” was marked as seen. This only changed the card on this page — nothing was sent.`);
        await refreshInbox(true);
        await refreshState();
      } catch (err) {
        state.focusCardAfterRender = null;
        b.disabled = false;
        b.textContent = 'Mark as seen';
        b.focus();
        showInlineError('#inbox-error',
          `The card could not be confirmed as seen (${err.message}). You can try again — marking the same card seen twice does not record a duplicate.`);
      }
    });
    actions.appendChild(b);
    actions.appendChild(el('span', 'ack-note',
      'Only marks the card on this page — nothing is sent to Maggie or anyone else.'));
  }
  body.appendChild(actions);

  // Dana's human follow-up loop, separate from Mark as seen: recording a
  // step notes what Dana says she did or plans — no call is placed and no
  // message is sent. Steps already recorded appear in the timeline above.
  if (Array.isArray(card.available_actions) && card.available_actions.length) {
    const group = el('div', 'action-group');
    const label = el('span', 'action-group-label');
    const labelIcon = el('span', 'why-icon');
    labelIcon.setAttribute('aria-hidden', 'true');
    labelIcon.innerHTML = ICONS.phone;
    label.appendChild(labelIcon);
    label.appendChild(document.createTextNode('What did Dana do next? Record it:'));
    group.appendChild(label);

    const row = el('div', 'action-row');
    for (const action of card.available_actions) {
      const def = ACTION_LABELS[action];
      if (!def) continue;
      const text = def.button(firstName);
      const b = el('button', 'btn btn-ghost btn-small action-btn', text);
      b.type = 'button';
      b.setAttribute('aria-label', `${text} — records the step on this page only, nothing is called or sent`);
      b.addEventListener('click', async () => {
        if (b.disabled) return;
        // Focus restore: the re-rendered card has one fewer button.
        state.focusCardAfterRender = String(card.id);
        b.disabled = true;
        b.textContent = 'Recording…';
        showInlineError('#inbox-error', '');
        try {
          await api(`/api/inbox/${card.id}/action`, {
            method: 'POST',
            body: JSON.stringify({ senior_id: SENIOR_ID, action }),
          });
          announce(`Recorded: ${def.timeline(firstName)}. This only noted the step on this page — no call was placed and nothing was sent.`);
          await refreshInbox(true);
        } catch (err) {
          state.focusCardAfterRender = null;
          b.disabled = false;
          b.textContent = text;
          b.focus();
          showInlineError('#inbox-error',
            `The step could not be confirmed as recorded (${err.message}). You can try again — recording the same step twice does not create a duplicate.`);
        }
      });
      row.appendChild(b);
    }
    group.appendChild(row);
    group.appendChild(el('span', 'ack-note',
      'Recording only — no call is placed, nothing is sent, and this is not a medical or emergency response.'));
    body.appendChild(group);
  }
  box.appendChild(body);
  return box;
}

function renderInbox(data) {
  // Preserve keyboard focus across re-renders: prefer the card a pending
  // action marked for restore, then whatever card holds focus right now.
  const focusedId = state.focusCardAfterRender
    || document.activeElement?.dataset?.cardId
    || document.activeElement?.closest?.('.thread-card')?.dataset?.cardId;
  state.focusCardAfterRender = null;

  const cards = data.cards || [];
  const open = cards.filter((c) => c.status !== 'acknowledged');
  const seen = cards.filter((c) => c.status === 'acknowledged');
  const currentIds = new Set(cards.map((c) => c.id));

  inboxOpenEl.innerHTML = '';
  if (!open.length) {
    inboxOpenEl.appendChild(el('p', 'empty-note',
      'Nothing needs attention right now. If a morning goes quiet or Maggie’s words sound worrying, a card will appear here — inside this demo only.'));
  }
  for (const card of open) {
    inboxOpenEl.appendChild(renderThreadCard(card, { isNew: !state.lastCardIds.has(card.id) && state.lastCardIds.size > 0 }));
  }

  inboxSeenEl.innerHTML = '';
  $('#earlier-head').hidden = seen.length === 0;
  for (const card of seen) {
    inboxSeenEl.appendChild(renderThreadCard(card));
  }

  inboxFollowupsEl.innerHTML = '';
  const followups = data.followups || [];
  if (!followups.length) {
    inboxFollowupsEl.appendChild(el('p', 'empty-note',
      'No extra check-ins are scheduled. After a worrying message, KinKeeper schedules a sooner check-back with Maggie here.'));
  }
  for (const f of followups) {
    const row = el('div', 'followup');
    row.appendChild(el('span', `badge ${f.status === 'pending' ? 'info' : 'gray'}`,
      f.status === 'pending' ? 'Coming up' : f.status));
    row.appendChild(el('span', '', f.reason));
    row.appendChild(el('span', 'card-ts', `due ${fmtClock(f.due_ts)}`));
    inboxFollowupsEl.appendChild(row);
  }

  state.lastCardIds = currentIds;

  if (focusedId) {
    const cardEl = document.querySelector(`[data-card-id="${CSS.escape(focusedId)}"]`);
    if (cardEl) {
      // Restore focus to an actionable control — the Why toggle keeps the
      // user's place in the evidence they had open; the card itself (with a
      // visible :focus ring) is the fallback. Scripted focus does not match
      // :focus-visible in Chrome, so the restored control gets an explicit
      // ring class until it loses focus.
      const target = cardEl.querySelector('.why-toggle') || cardEl.querySelector('button') || cardEl;
      target.focus({ preventScroll: true });
      target.classList.add('focus-restored');
      target.addEventListener('blur', () => target.classList.remove('focus-restored'), { once: true });
      // Scroll so the ACTUAL focused control sits fully inside the band
      // between the live sticky masthead bottom and the viewport bottom —
      // aligning only the card left a low Why toggle below the fold at
      // 375px. Offsets are measured live: the masthead height changes with
      // viewport width and banner wrapping, so a static CSS scroll-margin
      // alone under-shoots. focusScrollDelta picks the minimum movement,
      // keeping as much surrounding card context in view as possible.
      // behavior:'auto' is instant, which also satisfies reduced motion.
      const rect = cardEl.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const mastBottom = document.querySelector('.masthead')?.getBoundingClientRect().bottom || 0;
      const delta = focusScrollDelta({
        mastBottom,
        viewBottom: window.innerHeight,
        cardTop: rect.top,
        cardBottom: rect.bottom,
        targetTop: targetRect.top,
        targetBottom: targetRect.bottom,
        isCardTarget: target === cardEl,
      });
      if (delta) window.scrollBy({ top: delta, behavior: 'auto' });
    }
  }
}

const inboxFollowupsEl = $('#inbox-followups');

async function refreshInbox(showErrors) {
  try {
    const data = await api(`/api/inbox?senior_id=${encodeURIComponent(SENIOR_ID)}`);
    showInlineError('#inbox-error', '');
    renderInbox(data);
  } catch (err) {
    if (showErrors) {
      showInlineError('#inbox-error',
        `Family updates could not be loaded (${err.message}). The cards you may still see are from the last successful load — press Refresh to try again.`);
    }
  }
}

$('#inbox-refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  await refreshInbox(true);
  btn.disabled = false;
  btn.textContent = 'Refresh';
});

/* ----------------------------------------------------------------- journal */
const journalEl = $('#journal');
const MOOD_LABEL = { '-2': 'very low', '-1': 'low', '0': 'steady', '1': 'good', '2': 'very good' };

function factChips(facts = {}) {
  const wrap = el('div', 'j-facts');
  const add = (text, cls = '') => wrap.appendChild(el('span', `fact ${cls}`.trim(), text));
  if (facts.sleep_hours != null) add(`Sleep ${facts.sleep_hours}h`, facts.sleep_hours >= 7 ? 'good' : 'warn');
  if (facts.meds_taken === true) add('Meds taken', 'good');
  else if (facts.meds_taken === false) add('Meds not taken (her words)', 'warn');
  else add('Meds not mentioned');
  for (const a of facts.activities || []) add(a, 'info');
  const mood = MOOD_LABEL[String(facts.mood ?? 0)] ?? 'steady';
  add(`Mood: ${mood}`, (facts.mood ?? 0) < 0 ? 'warn' : 'good');
  for (const t of facts.topics || []) add(`Topic: ${t}`, 'info');
  for (const rf of facts.risk_flags || []) add(`Mentioned: ${rf}`, 'risk');
  for (const nf of facts.negated_flags || []) add(`Ruled out: ${nf}`);
  return wrap;
}

async function refreshJournal(showErrors = true) {
  try {
    const data = await api(`/api/journal?senior_id=${encodeURIComponent(SENIOR_ID)}&days=7`);
    showInlineError('#journal-error', '');
    state.journalLoaded = true;
    journalEl.innerHTML = '';
    const entries = data.entries || [];
    if (!entries.length) {
      journalEl.appendChild(el('p', 'empty-note', 'No earlier conversations yet — Maggie’s first check-in will be remembered here.'));
      return;
    }
    for (const e of [...entries].reverse()) {
      const card = el('article', 'j-entry');
      const head = el('div', 'j-head');
      head.appendChild(el('span', 'j-date', fmtDay(e.date)));
      head.appendChild(el('span', 'j-time', `${fmtTimeShort(e.ts)} UTC`));
      card.appendChild(head);
      card.appendChild(el('p', 'j-excerpt', e.excerpt));
      card.appendChild(factChips(e.facts));
      journalEl.appendChild(card);
    }
  } catch (err) {
    if (showErrors) {
      showInlineError('#journal-error',
        `Earlier conversations could not be loaded (${err.message}). You can try the refresh button.`);
    }
  }
}

$('#journal-refresh').addEventListener('click', () => refreshJournal(true));

$('#journal-block').addEventListener('toggle', (e) => {
  if (e.target.open && !state.journalLoaded) refreshJournal(true);
});

/* ------------------------------------------------------------------- boot */
updateVoiceBtn();
/* Unsupported speech controls stay focusable (aria-disabled) so keyboard and
   touch users can still discover them, but the explanation must not live only
   in a hover title: the persistent #speech-note states it visibly, directly
   under the buttons, and each affected button points at it with
   aria-describedby. The copy stays short so the whole caption fits beside the
   controls in the first 375 px viewport. */
const speechNote = $('#speech-note');
const micUnsupported = !SR;
const voiceUnsupported = !canSpeak;
if (voiceUnsupported) {
  state.voiceOn = false;
  updateVoiceBtn();
  voiceBtn.classList.add('is-unsupported');
  voiceBtn.setAttribute('aria-disabled', 'true');
  voiceBtn.setAttribute('aria-describedby', 'speech-note');
  voiceBtn.title = 'Voice output is not supported in this browser — all replies stay readable as text';
}
if (micUnsupported) {
  micBtn.classList.add('is-unsupported');
  micBtn.setAttribute('aria-disabled', 'true');
  micBtn.setAttribute('aria-describedby', 'speech-note');
  micBtn.title = 'Voice input is not supported in this browser — typing works exactly the same';
}
if (micUnsupported || voiceUnsupported) {
  speechNote.textContent = micUnsupported && voiceUnsupported
    ? 'Voice input and read-aloud aren’t available in this browser — typing works the same.'
    : micUnsupported
      ? 'Voice input isn’t available in this browser — typing works the same.'
      : 'Read-aloud isn’t available in this browser — every reply stays readable as text.';
  speechNote.hidden = false;
}
seedChatGreeting();
refreshState();
refreshInbox(false);
setInterval(refreshState, 10000);
