// KinKeeper entry point.
// One process serves: (1) the self-hosted MCP endpoint /mcp (Streamable
// HTTP, spec 2025-11-25), (2) the demo REST API the web app uses, and
// (3) the static simulated-Alexa+ web experience.
import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createStore } from './store.js';
import { createClock } from './clock.js';
import { createScheduler } from './scheduler.js';
import { createKinkeeperMcpServer } from './mcp/server.js';
import { createMcpClientPool } from './mcp/client.js';
import { createOrchestrator } from './orchestrator.js';
import { seedIfEmpty } from './seed.js';
import { dayStr } from './rules.js';
import {
  FAMILY_ACTIONS,
  FAMILY_ACTION_TRUTH_NOTE,
  isActionableCard,
  availableActions,
  buildTimeline,
  buildWhy,
} from './familyloop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.KINKEEPER_DB || path.join(__dirname, '..', 'data', 'kinkeeper.db');

// Local-only by default: the demo holds raw journal/audit reads, MCP writes,
// reset and time-warp endpoints, so it binds to loopback unless the operator
// explicitly opts into a broader bind AND sets a bearer token.
const HOST = process.env.KINKEEPER_HOST || '127.0.0.1';
const AUTH_TOKEN = process.env.KINKEEPER_TOKEN || null;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const isLoopbackHost = (host) => LOOPBACK_HOSTS.has(host);
const isLoopbackIp = (ip) =>
  ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '[::1]';

export async function startServer({ port = PORT, dbPath = DB_PATH, host = HOST, authToken = AUTH_TOKEN, tickMs = 3000 } = {}) {
  if (!isLoopbackHost(host) && !authToken) {
    throw new Error(
      `Refusing to bind KinKeeper to "${host}" without authentication. ` +
        'The demo exposes raw journal/audit reads, MCP writes, reset and time-warp endpoints. ' +
        'Either keep the default 127.0.0.1 bind, or set KINKEEPER_TOKEN and send ' +
        '"Authorization: Bearer <token>" with every non-local request.'
    );
  }
  const store = createStore(dbPath);
  const clock = createClock(store);
  seedIfEmpty(store, clock);

  const scheduler = createScheduler({ store, clock, tickMs });
  const mcpClient = createMcpClientPool({
    serverUrl: `http://127.0.0.1:${port}/mcp`,
    onEvent: (e) =>
      store.audit({
        ts_virtual: clock.nowIso(),
        direction: 'system',
        method: 'mcp.client_connected',
        detail: e,
      }),
  });
  const orchestrator = createOrchestrator({ store, clock, mcp: mcpClient });

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Access guard. With the default loopback bind this never triggers (the OS
  // already keeps remote clients out); with an explicit broad bind, every
  // /api and /mcp endpoint is local-only or requires the bearer token.
  const broadBind = !isLoopbackHost(host);
  app.use((req, res, next) => {
    if (!broadBind) return next();
    if (!req.path.startsWith('/api') && !req.path.startsWith('/mcp')) return next();
    if (isLoopbackIp(req.ip)) return next();
    const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (authToken && presented === authToken) return next();
    res
      .status(403)
      .json({ error: 'Forbidden: KinKeeper demo endpoints are local-only, or require "Authorization: Bearer <KINKEEPER_TOKEN>" when bound beyond localhost.' });
  });

  // ---- MCP endpoint (Streamable HTTP, stateful sessions) -----------------
  const transports = new Map(); // sessionId -> transport

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    let transport;
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      store.audit({
        ts_virtual: clock.nowIso(),
        direction: 'mcp-in',
        method: 'initialize',
        detail: {
          protocolVersion: req.body?.params?.protocolVersion,
          clientInfo: req.body?.params?.clientInfo,
        },
      });
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          store.audit({
            ts_virtual: clock.nowIso(),
            direction: 'system',
            method: 'mcp.session_initialized',
            detail: { session_id: sid },
          });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const server = createKinkeeperMcpServer({ store, clock });
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid MCP session id. Send initialize first.' },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const sessionRequestHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).send('Invalid or missing MCP session id');
      return;
    }
    await transports.get(sessionId).handleRequest(req, res);
  };
  app.get('/mcp', sessionRequestHandler);
  app.delete('/mcp', sessionRequestHandler);

  // ---- Demo REST API used by the web experience --------------------------
  app.get('/api/state', (req, res) => {
    const nowIso = clock.nowIso();
    const today = dayStr(nowIso);
    const seniors = store.listSeniors().map((s) => {
      const checkins = store.getEvents(s.id, { type: 'checkin_recorded' });
      const todays = checkins.filter((e) => e.payload.date === today);
      return {
        ...s,
        today,
        scheduled: `${today}T${s.checkin_time}:00.000Z`,
        checked_in_today: todays.length > 0,
        last_checkin: checkins.at(-1)?.payload ?? null,
        // Latest deterministic risk assessment, so the RIGHT NOW panel renders
        // from persisted server state instead of in-memory page state (which
        // is empty after a refresh and used to show a contradictory
        // "No check-in yet" next to "Checked in today: Yes").
        last_risk: store.getEvents(s.id, { type: 'risk_assessed' }).at(-1)?.payload ?? null,
        open_cards: store.listCards(s.id, { status: 'open' }).length,
        pending_followups: store.listFollowups(s.id).filter((f) => f.status === 'pending').length,
      };
    });
    res.json({
      clock_now: nowIso,
      seniors,
      audit_entries: store.listAudit({ limit: 1 }).length ? undefined : 0,
      mcp: {
        endpoint: '/mcp',
        transport: 'streamable-http',
        protocol_versions_supported: ['2025-11-25', '2025-06-18', '2025-03-26'],
        active_sessions: transports.size,
      },
      safety:
        'Synthetic care-coordination demo. Not medical advice, not a medical device, no emergency response. ' +
        'No real notifications are ever sent — cards wait in the local family inbox.',
    });
  });

  app.post('/api/chat', async (req, res) => {
    try {
      const { senior_id, message } = req.body || {};
      if (!senior_id || !message) return res.status(400).json({ error: 'senior_id and message are required' });
      const result = await orchestrator.handleMessage(senior_id, String(message));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // Peek at the next pending proactive prompt. A GET never marks anything
  // delivered — speaking is confirmed explicitly via /api/proactive/ack.
  app.get('/api/proactive', (req, res) => {
    const { senior_id } = req.query;
    if (!senior_id) return res.status(400).json({ error: 'senior_id is required' });
    res.json(orchestrator.getProactive(String(senior_id)));
  });

  app.post('/api/proactive/ack', (req, res) => {
    const { senior_id, event_id } = req.body || {};
    if (!senior_id || event_id == null) {
      return res.status(400).json({ error: 'senior_id and event_id are required' });
    }
    res.json(orchestrator.ackProactive(String(senior_id), Number(event_id)));
  });

  // Enrich an inbox card with Dana's action loop state, the factual
  // chronological timeline, and the plain-language "Why this card?" evidence.
  const enrichCard = (card) => {
    const actions = store.listCardActions(card.id);
    const senior = store.getSenior(card.senior_id);
    return {
      ...card,
      actions: actions.map((a) => ({ action: a.action, ts: a.created_ts })),
      available_actions: availableActions(card, actions),
      timeline: buildTimeline(card, actions),
      why: buildWhy({ store, card, senior }),
    };
  };

  app.get('/api/inbox', (req, res) => {
    const { senior_id } = req.query;
    if (!senior_id) return res.status(400).json({ error: 'senior_id is required' });
    res.json({
      cards: store.listCards(String(senior_id)).map(enrichCard),
      followups: store.listFollowups(String(senior_id)),
    });
  });

  // Dana marks a card as seen. Same ownership guard as the action loop: the
  // claimed senior must exist and must own this card — and every rejection
  // happens before any mutation, so a failed ack never touches the card.
  app.post('/api/inbox/:id/ack', (req, res) => {
    const id = Number(req.params.id);
    const card = Number.isInteger(id) && id > 0 ? store.getCard(id) : null;
    if (!card) return res.status(404).json({ error: 'card not found' });
    const { senior_id } = req.body || {};
    if (!senior_id) return res.status(400).json({ error: 'senior_id is required' });
    const senior = store.getSenior(String(senior_id));
    if (!senior) return res.status(400).json({ error: `unknown senior_id "${senior_id}"` });
    if (card.senior_id !== senior.id) {
      return res.status(400).json({ error: 'this card does not belong to that senior' });
    }
    // Idempotent: re-acking an already-acknowledged card replays its state
    // without a second seen record (store.ackCard guards both).
    res.json(enrichCard(store.ackCard(card.id, clock.nowIso())));
  });

  // Dana records a human follow-up step on a card. Truthful by construction:
  // the endpoint only writes a local record of what Dana SAYS she did or
  // plans — it never places a call, sends a message, or concludes anything.
  app.post('/api/inbox/:id/action', (req, res) => {
    const card = store.getCard(Number(req.params.id));
    if (!card) return res.status(404).json({ error: 'card not found' });
    const { senior_id, action } = req.body || {};
    if (!senior_id || !action) {
      return res.status(400).json({ error: 'senior_id and action are required' });
    }
    // Guard against acting on the wrong senior's card: the claimed senior
    // must exist and must own this card.
    const senior = store.getSenior(String(senior_id));
    if (!senior) return res.status(400).json({ error: `unknown senior_id "${senior_id}"` });
    if (card.senior_id !== senior.id) {
      return res.status(400).json({ error: 'this card does not belong to that senior' });
    }
    if (!FAMILY_ACTIONS[action]) {
      return res.status(400).json({
        error: `unknown action "${action}" — expected one of: ${Object.keys(FAMILY_ACTIONS).join(', ')}`,
      });
    }
    if (!isActionableCard(card)) {
      return res.status(400).json({ error: 'this card has no follow-up action loop' });
    }

    const dedupeKey = `action:${card.id}:${action}`;
    // Idempotent double submit: the step is already recorded, so replay the
    // original record rather than appending a second timeline entry.
    const existing = store.getCardActionByDedupeKey(dedupeKey);
    if (existing) {
      return res.json({
        ok: true,
        deduplicated: true,
        card_id: card.id,
        senior_id: senior.id,
        action,
        recorded: { action: existing.action, ts: existing.created_ts },
        available_actions: availableActions(card, store.listCardActions(card.id)),
        truth_note: FAMILY_ACTION_TRUTH_NOTE,
        card: enrichCard(store.getCard(card.id)),
      });
    }
    const recorded = store.listCardActions(card.id);
    if (!availableActions(card, recorded).includes(action)) {
      return res.status(400).json({ error: `action "${action}" is not available on this card` });
    }

    const ts = clock.nowIso();
    const row = store.addCardAction({
      card_id: card.id,
      senior_id: senior.id,
      action,
      created_ts: ts,
      dedupe_key: dedupeKey,
    });
    store.appendEvent({
      ts,
      senior_id: senior.id,
      type: 'family_action_recorded',
      payload: { card_id: card.id, action, external_action_taken: false },
      dedupe_key: `family-action:${card.id}:${action}`,
    });
    res.json({
      ok: true,
      deduplicated: false,
      card_id: card.id,
      senior_id: senior.id,
      action,
      recorded: { action: row.action, ts: row.created_ts },
      available_actions: availableActions(card, store.listCardActions(card.id)),
      truth_note: FAMILY_ACTION_TRUTH_NOTE,
      card: enrichCard(store.getCard(card.id)),
    });
  });

  app.get('/api/audit', (req, res) => {
    res.json({ entries: store.listAudit({ limit: Number(req.query.limit || 300) }).reverse() });
  });

  app.get('/api/journal', (req, res) => {
    const { senior_id, days = 7 } = req.query;
    if (!senior_id) return res.status(400).json({ error: 'senior_id is required' });
    const since = new Date(new Date(clock.nowIso()).getTime() - Number(days) * 86400000).toISOString();
    res.json({
      entries: store.getEvents(String(senior_id), { type: 'checkin_recorded', sinceTs: since }).map((e) => ({
        event_id: Number(e.id),
        date: e.payload.date,
        ts: e.ts,
        excerpt: e.payload.quote,
        facts: e.payload.facts,
      })),
    });
  });

  app.post('/api/digest', async (req, res) => {
    try {
      const { senior_id } = req.body || {};
      if (!senior_id) return res.status(400).json({ error: 'senior_id is required' });
      res.json(await orchestrator.getDigest(String(senior_id)));
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // ---- Demo time controls (an honest presentation device, fully audited) --
  // Trust boundary for the shared clock: bad to_iso / minutes never reach a
  // write. clock.setTime/advance also reject before persisting; either layer
  // answers JSON 400 and leaves the previous offset in place.
  app.post('/api/demo/advance', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'provide minutes (>0) or to_iso' });
    }
    const { minutes, to_iso } = body;
    const hasToIso = to_iso !== undefined && to_iso !== null && to_iso !== '';
    const hasMinutes = minutes !== undefined && minutes !== null && minutes !== '';
    try {
      let now;
      let before;
      if (hasToIso) {
        if (typeof to_iso !== 'string') {
          return res.status(400).json({ error: 'to_iso must be a valid date string' });
        }
        before = clock.nowIso();
        now = clock.setTime(new Date(to_iso));
      } else if (hasMinutes) {
        const ms = typeof minutes === 'number' ? minutes * 60000 : Number.NaN;
        if (typeof minutes !== 'number' || !Number.isFinite(minutes) || !(minutes > 0) || !Number.isFinite(ms)) {
          return res.status(400).json({ error: 'minutes must be a finite number > 0' });
        }
        before = clock.nowIso();
        now = clock.advance(ms);
      } else {
        return res.status(400).json({ error: 'provide minutes (>0) or to_iso' });
      }
      store.appendEvent({
        ts: clock.nowIso(),
        senior_id: 'demo',
        type: 'demo_clock_advanced',
        payload: { before, after: now.toISOString() },
      });
      store.audit({
        ts_virtual: clock.nowIso(),
        direction: 'system',
        method: 'demo.clock_advanced',
        detail: { before, after: now.toISOString() },
      });
      scheduler.tickOnce(); // let deterministic rules react immediately
      res.json({ before, now: now.toISOString() });
    } catch (err) {
      if (err?.code === 'CLOCK_INPUT') {
        return res.status(400).json({ error: err.message });
      }
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.post('/api/demo/reset', async (req, res) => {
    seedIfEmpty(store, clock, { force: true });
    scheduler.tickOnce();
    res.json({ reset: true, clock_now: clock.nowIso() });
  });

  // ---- Static web experience ----------------------------------------------
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const httpServer = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });

  scheduler.start();
  const actualPort = httpServer.address().port;
  console.log(`KinKeeper demo running:`);
  console.log(`  Web experience : http://localhost:${actualPort}/`);
  console.log(`  MCP endpoint   : http://localhost:${actualPort}/mcp  (Streamable HTTP, spec 2025-11-25)`);
  console.log(`  Binding        : ${host}${broadBind ? ' (broad bind — bearer-token auth enforced on /api and /mcp)' : ' (local-only)'}`);
  console.log(`  Database       : ${dbPath}`);

  return {
    port: actualPort,
    store,
    clock,
    scheduler,
    mcpClient,
    async close() {
      scheduler.stop();
      await mcpClient.close();
      for (const t of transports.values()) {
        try {
          await t.close();
        } catch {}
      }
      await new Promise((r) => httpServer.close(r));
      store.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer().catch((err) => {
    if (/ERR_DLOPEN_FAILED|NODE_MODULE_VERSION/.test(String(err?.message || err))) {
      console.error(
        'better-sqlite3 failed to load: its native binary was built for a different Node.js major version.\n' +
          `This project requires Node.js 22 (you are running ${process.version}).\n` +
          'Fix: run KinKeeper with Node 22, or rebuild the native module for your current Node: npm rebuild better-sqlite3'
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
