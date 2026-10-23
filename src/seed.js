// Seed: one clearly-fictional senior persona plus three days of synthetic
// check-in history, so cross-session recall works from the first message.
// All data is invented for this demo; no real person's data is used.
import { extractFacts } from './extract.js';
import { dayStr } from './rules.js';

export const SYNTHETIC_SENIOR = {
  id: 'maggie',
  display_name: 'Maggie Rivera',
  checkin_time: '09:00',
  grace_minutes: 45,
  concerns: ['knee', 'medication', 'sleep'],
  family_contact: 'Dana (daughter)',
};

const HISTORY = [
  {
    daysAgo: 3,
    at: '09:04',
    transcript: 'Good morning! I slept about 7 hours, took my meds, and walked the dog before breakfast. Feeling good today.',
  },
  {
    daysAgo: 2,
    at: '09:12',
    transcript: "I'm okay I suppose. My knee has been hurting a bit since yesterday. Only slept 5 hours. I did take my pills though.",
  },
  {
    daysAgo: 1,
    at: '09:02',
    transcript: 'Morning! Took my medication with breakfast. Knee is still sore but I did a little gardening anyway.',
  },
];

function isoDaysAgo(clock, daysAgo, at) {
  const base = new Date(clock.nowIso());
  base.setUTCDate(base.getUTCDate() - daysAgo);
  return `${dayStr(base.toISOString())}T${at}:00.000Z`;
}

export function seedIfEmpty(store, clock, { force = false } = {}) {
  const existing = store.listSeniors();
  if (existing.length > 0 && !force) return { seeded: false, seniors: existing.length };

  if (force) {
    for (const table of ['events', 'inbox_cards', 'card_actions', 'followups', 'audit', 'config']) {
      store.db.prepare(`DELETE FROM ${table}`).run();
    }
  }

  // Demo morning starts at 08:55 so the 09:00 check-in is due within minutes.
  const nowUtc = new Date();
  const start = new Date(`${dayStr(nowUtc.toISOString())}T08:55:00.000Z`);
  clock.setTime(start);

  store.upsertSenior({ ...SYNTHETIC_SENIOR, created_ts: clock.nowIso() });

  const senior = store.getSenior(SYNTHETIC_SENIOR.id);
  for (const h of HISTORY) {
    const ts = isoDaysAgo(clock, h.daysAgo, h.at);
    const facts = extractFacts(h.transcript, senior.concerns);
    store.appendEvent({
      ts,
      senior_id: senior.id,
      type: 'checkin_recorded',
      payload: {
        date: dayStr(ts),
        transcript: h.transcript,
        facts,
        quote: h.transcript.length > 160 ? `${h.transcript.slice(0, 157)}…` : h.transcript,
        seeded: true,
      },
    });
  }

  store.audit({
    ts_virtual: clock.nowIso(),
    direction: 'system',
    method: 'demo.seeded',
    detail: {
      senior: senior.display_name,
      synthetic: true,
      history_days: HISTORY.length,
      note: 'All personas and data are fictional and generated locally.',
    },
  });
  return { seeded: true, seniors: 1 };
}

// Standalone: `node src/seed.js [--reset]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { createStore } = await import('./store.js');
  const { createClock } = await import('./clock.js');
  const dbPath = process.env.KINKEEPER_DB || new URL('../data/kinkeeper.db', import.meta.url).pathname;
  const store = createStore(dbPath);
  const clock = createClock(store);
  const result = seedIfEmpty(store, clock, { force: process.argv.includes('--reset') });
  console.log(result.seeded ? `Seeded synthetic demo data into ${dbPath}` : 'Database already seeded (use --reset to reseed)');
  store.close();
}
