// Persistent event store (SQLite, append-only events + projections).
// Every state change in KinKeeper is an event row; inbox cards, followups
// and audit entries are projections with idempotency keys.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seniors (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  checkin_time TEXT NOT NULL,          -- 'HH:MM' local demo time
  grace_minutes INTEGER NOT NULL DEFAULT 45,
  concerns TEXT NOT NULL DEFAULT '[]', -- JSON array of watched topics
  family_contact TEXT NOT NULL DEFAULT '',
  created_ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,                    -- virtual clock ISO timestamp
  senior_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'   -- JSON
);
CREATE INDEX IF NOT EXISTS idx_events_senior_type ON events(senior_id, type, ts);
CREATE TABLE IF NOT EXISTS inbox_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts TEXT NOT NULL,
  senior_id TEXT NOT NULL,
  severity TEXT NOT NULL,              -- 'info' | 'green' | 'amber'
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  quote TEXT,
  suggested_action TEXT,
  source TEXT NOT NULL DEFAULT '{}',   -- JSON: rule_id, event_ids, reasons
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'acknowledged'
  dedupe_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  senior_id TEXT NOT NULL,
  due_ts TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'fired' | 'cancelled'
  created_ts TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS card_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  senior_id TEXT NOT NULL,
  action TEXT NOT NULL,            -- 'plan_call' | 'tried_call' | 'reached' | 'follow_up_later'
  created_ts TEXT NOT NULL,        -- virtual clock ISO timestamp (never fabricated)
  dedupe_key TEXT NOT NULL UNIQUE  -- one record per (card, action): double submits replay
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_real TEXT NOT NULL,
  ts_virtual TEXT NOT NULL,
  direction TEXT NOT NULL,             -- 'mcp-in' | 'mcp-out' | 'system'
  method TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'    -- JSON
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function createStore(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  // Migration: events gain an optional idempotency key so a retried mutation
  // (e.g. a re-sent record_checkin) is recorded exactly once. NULL keys are
  // exempt from the unique index, so plain appends are unaffected.
  const eventCols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  if (!eventCols.includes('dedupe_key')) {
    db.exec('ALTER TABLE events ADD COLUMN dedupe_key TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe_key ON events(dedupe_key)');

  // Migration: inbox_cards gain an optional acknowledgement timestamp so the
  // family timeline can state WHEN a card was seen. Pre-existing acknowledged
  // rows keep NULL — the UI then says "seen" without inventing a time.
  const cardCols = db.prepare('PRAGMA table_info(inbox_cards)').all().map((c) => c.name);
  if (!cardCols.includes('ack_ts')) {
    db.exec('ALTER TABLE inbox_cards ADD COLUMN ack_ts TEXT');
  }

  const insertEvent = db.prepare(
    'INSERT OR IGNORE INTO events (ts, senior_id, type, payload, dedupe_key) VALUES (?, ?, ?, ?, ?)'
  );
  const getEventByDedupe = db.prepare('SELECT * FROM events WHERE dedupe_key = ?');
  const insertCard = db.prepare(
    `INSERT OR IGNORE INTO inbox_cards
       (created_ts, senior_id, severity, title, body, quote, suggested_action, source, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFollowup = db.prepare(
    `INSERT OR IGNORE INTO followups (senior_id, due_ts, reason, created_ts, dedupe_key)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertAudit = db.prepare(
    'INSERT INTO audit (ts_real, ts_virtual, direction, method, detail) VALUES (?, ?, ?, ?, ?)'
  );
  const insertCardAction = db.prepare(
    `INSERT OR IGNORE INTO card_actions (card_id, senior_id, action, created_ts, dedupe_key)
     VALUES (?, ?, ?, ?, ?)`
  );

  return {
    db,

    getConfig(key) {
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
      return row ? row.value : null;
    },
    setConfig(key, value) {
      db.prepare(
        'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(key, value);
    },

    upsertSenior(senior) {
      db.prepare(
        `INSERT INTO seniors (id, display_name, checkin_time, grace_minutes, concerns, family_contact, created_ts)
         VALUES (@id, @display_name, @checkin_time, @grace_minutes, @concerns, @family_contact, @created_ts)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           checkin_time = excluded.checkin_time,
           grace_minutes = excluded.grace_minutes,
           concerns = excluded.concerns,
           family_contact = excluded.family_contact`
      ).run({ ...senior, concerns: JSON.stringify(senior.concerns || []) });
    },
    getSenior(id) {
      const row = db.prepare('SELECT * FROM seniors WHERE id = ?').get(id);
      if (!row) return null;
      return { ...row, concerns: JSON.parse(row.concerns) };
    },
    listSeniors() {
      return db
        .prepare('SELECT * FROM seniors ORDER BY created_ts')
        .all()
        .map((r) => ({ ...r, concerns: JSON.parse(r.concerns) }));
    },

    appendEvent({ ts, senior_id, type, payload = {}, dedupe_key = null }) {
      const info = insertEvent.run(ts, senior_id, type, JSON.stringify(payload), dedupe_key);
      if (info.changes === 0 && dedupe_key) {
        // Idempotent replay: return the originally recorded event.
        const row = getEventByDedupe.get(dedupe_key);
        return { id: row.id, ts: row.ts, senior_id: row.senior_id, type: row.type, payload: JSON.parse(row.payload), created: false };
      }
      return { id: info.lastInsertRowid, ts, senior_id, type, payload, created: true };
    },
    getEvents(seniorId, { type, sinceTs, limit = 500 } = {}) {
      let sql = 'SELECT * FROM events WHERE senior_id = ?';
      const args = [seniorId];
      if (type) {
        sql += ' AND type = ?';
        args.push(type);
      }
      if (sinceTs) {
        sql += ' AND ts >= ?';
        args.push(sinceTs);
      }
      sql += ' ORDER BY ts ASC, id ASC LIMIT ?';
      args.push(limit);
      return db
        .prepare(sql)
        .all(...args)
        .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    },

    addCard(card) {
      const info = insertCard.run(
        card.created_ts,
        card.senior_id,
        card.severity,
        card.title,
        card.body,
        card.quote || null,
        card.suggested_action || null,
        JSON.stringify(card.source || {}),
        card.dedupe_key
      );
      if (info.changes === 0) return null; // idempotent: already existed
      return this.getCard(info.lastInsertRowid);
    },
    getCard(id) {
      const row = db.prepare('SELECT * FROM inbox_cards WHERE id = ?').get(id);
      return row ? { ...row, source: JSON.parse(row.source) } : null;
    },
    getCardByDedupeKey(dedupeKey) {
      const row = db.prepare('SELECT * FROM inbox_cards WHERE dedupe_key = ?').get(dedupeKey);
      return row ? { ...row, source: JSON.parse(row.source) } : null;
    },
    listCards(seniorId, { status } = {}) {
      let sql = 'SELECT * FROM inbox_cards WHERE senior_id = ?';
      const args = [seniorId];
      if (status) {
        sql += ' AND status = ?';
        args.push(status);
      }
      sql += ' ORDER BY created_ts DESC, id DESC';
      return db
        .prepare(sql)
        .all(...args)
        .map((r) => ({ ...r, source: JSON.parse(r.source) }));
    },
    ackCard(id, ts) {
      const before = this.getCard(id);
      if (!before) return null;
      if (before.status !== 'acknowledged') {
        db.prepare("UPDATE inbox_cards SET status = 'acknowledged', ack_ts = ? WHERE id = ?").run(ts, id);
        // Idempotent seen record in the event stream (one per card).
        this.appendEvent({
          ts,
          senior_id: before.senior_id,
          type: 'family_card_seen',
          payload: { card_id: Number(id), seen_ts: ts },
          dedupe_key: `seen:${id}`,
        });
      }
      return this.getCard(id);
    },

    getEvent(id) {
      const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
      return row ? { ...row, payload: JSON.parse(row.payload) } : null;
    },

    // Dana's human follow-up step on a card. One record per (card, action):
    // the unique dedupe key makes a double submit return the original record
    // instead of a duplicate timeline entry.
    addCardAction({ card_id, senior_id, action, created_ts, dedupe_key }) {
      const info = insertCardAction.run(card_id, senior_id, action, created_ts, dedupe_key);
      if (info.changes === 0) return null;
      return db.prepare('SELECT * FROM card_actions WHERE id = ?').get(info.lastInsertRowid);
    },
    getCardActionByDedupeKey(dedupeKey) {
      return db.prepare('SELECT * FROM card_actions WHERE dedupe_key = ?').get(dedupeKey) || null;
    },
    listCardActions(cardId) {
      return db
        .prepare('SELECT * FROM card_actions WHERE card_id = ? ORDER BY created_ts ASC, id ASC')
        .all(cardId);
    },

    // A late reply resolves the R1 missed-check-in card for that date: the
    // card stays visible for the family timeline, but its copy must no longer
    // claim KinKeeper is still awaiting a reply. The factual update applies to
    // acknowledged cards too — acknowledgement marks the card as seen by
    // family, it does not freeze its facts; the status itself is preserved
    // (an acknowledged card is not reopened).
    resolveMissedCheckinCards({ senior_id, date, reply_ts }) {
      const senior = this.getSenior(senior_id);
      const name = senior?.display_name || senior_id;
      const rows = db
        .prepare('SELECT * FROM inbox_cards WHERE senior_id = ? AND dedupe_key = ?')
        .all(senior_id, `card:missed:${date}`);
      const resolved = [];
      for (const row of rows) {
        const source = JSON.parse(row.source);
        if (source.resolved) continue; // already resolved by an earlier late reply
        source.resolved = { by: 'late_checkin', ts: reply_ts };
        const body =
          `${name} had not checked in by the scheduled time plus grace period when this card was created. ` +
          `${name} has since replied — the late check-in was recorded at ${reply_ts.slice(11, 16)} UTC, ` +
          `so KinKeeper is no longer awaiting a reply. See the journal for the latest check-in.`;
        db.prepare('UPDATE inbox_cards SET body = ?, source = ? WHERE id = ?').run(
          body,
          JSON.stringify(source),
          row.id
        );
        resolved.push(this.getCard(row.id));
      }
      return resolved;
    },

    addFollowup({ senior_id, due_ts, reason, created_ts, dedupe_key }) {
      const info = insertFollowup.run(senior_id, due_ts, reason, created_ts, dedupe_key);
      if (info.changes === 0) return null;
      return db.prepare('SELECT * FROM followups WHERE id = ?').get(info.lastInsertRowid);
    },
    getFollowupByDedupeKey(dedupeKey) {
      return db.prepare('SELECT * FROM followups WHERE dedupe_key = ?').get(dedupeKey) || null;
    },
    dueFollowups(nowIso) {
      return db
        .prepare("SELECT * FROM followups WHERE status = 'pending' AND due_ts <= ? ORDER BY due_ts")
        .all(nowIso);
    },
    markFollowupFired(id) {
      db.prepare("UPDATE followups SET status = 'fired' WHERE id = ?").run(id);
    },
    listFollowups(seniorId) {
      return db.prepare('SELECT * FROM followups WHERE senior_id = ? ORDER BY due_ts').all(seniorId);
    },

    audit({ ts_virtual, direction, method, detail = {} }) {
      const info = insertAudit.run(
        new Date().toISOString(),
        ts_virtual,
        direction,
        method,
        JSON.stringify(detail)
      );
      return info.lastInsertRowid;
    },
    listAudit({ limit = 200 } = {}) {
      return db
        .prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?')
        .all(limit)
        .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
    },

    close() {
      db.close();
    },
  };
}
