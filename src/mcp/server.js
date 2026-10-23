// KinKeeper MCP server factory.
// Exposes the care-coordination capability as real MCP tools over Streamable
// HTTP (spec 2025-11-25 via @modelcontextprotocol/sdk). The orchestrator
// reaches this server only through the MCP protocol — never by direct import.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { extractFacts } from '../extract.js';
import { dayStr } from '../rules.js';

const json = (obj) => [{ type: 'text', text: JSON.stringify(obj, null, 2) }];

export function createKinkeeperMcpServer({ store, clock }) {
  const server = new McpServer(
    { name: 'kinkeeper-care-coordination', version: '0.1.0' },
    { capabilities: { logging: {} } }
  );

  // Audit wrapper: every tool call lands in the persistent audit trail with
  // its arguments and result, so the demo can show real MCP traffic.
  function audited(name, handler) {
    return async (args) => {
      const ts = clock.nowIso();
      store.audit({ ts_virtual: ts, direction: 'mcp-in', method: 'tools/call', detail: { tool: name, arguments: args } });
      try {
        const result = await handler(args);
        store.audit({
          ts_virtual: clock.nowIso(),
          direction: 'mcp-out',
          method: 'tools/call',
          detail: { tool: name, ok: !result.isError, result: result.structuredContent ?? null },
        });
        return result;
      } catch (err) {
        store.audit({
          ts_virtual: clock.nowIso(),
          direction: 'mcp-out',
          method: 'tools/call',
          detail: { tool: name, ok: false, error: String(err?.message || err) },
        });
        return { content: json({ error: String(err?.message || err) }), isError: true };
      }
    };
  }

  function requireSenior(senior_id) {
    const senior = store.getSenior(senior_id);
    if (!senior) throw new Error(`unknown senior_id "${senior_id}"`);
    return senior;
  }

  server.registerTool(
    'record_checkin',
    {
      title: 'Record daily check-in',
      description:
        'Record a senior\'s daily check-in conversation transcript into the longitudinal care journal. ' +
        'Deterministically extracts facts (sleep, medication, activity, mood, risk phrases, watched topics) ' +
        'and returns a structured same-day status card.',
      inputSchema: {
        senior_id: z.string().describe('Synthetic senior persona id'),
        transcript: z.string().describe('What the senior said, verbatim'),
        occurred_at: z.string().datetime().optional().describe('ISO time of the check-in; defaults to server clock'),
        idempotency_key: z
          .string()
          .optional()
          .describe(
            'Stable key supplied by the caller. Retried calls with the same key return the ' +
              'original event instead of recording a duplicate check-in.'
          ),
      },
      outputSchema: z
        .object({
          event_id: z.number(),
          date: z.string(),
          status: z.enum(['ok', 'attention']),
          facts: z.object({}).passthrough(),
          transcript: z.string(),
          card: z.object({}).passthrough(),
        })
        .passthrough(),
    },
    audited('record_checkin', ({ senior_id, transcript, occurred_at, idempotency_key }) => {
      const senior = requireSenior(senior_id);
      const ts = occurred_at || clock.nowIso();
      const dedupe_key = idempotency_key ? `checkin:${senior_id}:${idempotency_key}` : null;
      const event = store.appendEvent({
        ts,
        senior_id,
        type: 'checkin_recorded',
        payload: {
          date: dayStr(ts),
          transcript,
          facts: extractFacts(transcript, senior.concerns),
          quote: transcript.length > 160 ? `${transcript.slice(0, 157)}…` : transcript,
        },
        dedupe_key,
      });
      // Facts come from the stored event, so an idempotent replay returns
      // exactly what was originally recorded.
      const facts = event.payload.facts;
      const date = event.payload.date;
      // An explicit "I have not taken my meds" is a self-reported fact the
      // senior stated — the daily card must never label such a day as
      // blanket "looks good". This is a status reflection, not a diagnosis.
      const status =
        facts.risk_flags.length > 0 || facts.mood < 0 || facts.meds_taken === false ? 'attention' : 'ok';

      let resolved_missed_cards = [];
      if (event.created) {
        // A check-in for a date closes the "still awaiting a reply" state of
        // that day's R1 missed-check-in card (late reply).
        resolved_missed_cards = store.resolveMissedCheckinCards({
          senior_id,
          date,
          reply_ts: clock.nowIso(),
        });
        for (const card of resolved_missed_cards) {
          store.appendEvent({
            ts: clock.nowIso(),
            senior_id,
            type: 'missed_checkin_resolved',
            payload: { card_id: card.id, checkin_event_id: Number(event.id), date },
          });
        }
      }

      const structured = {
        event_id: Number(event.id),
        date,
        status,
        facts,
        transcript: event.payload.transcript,
        deduplicated: !event.created,
        idempotency_key: idempotency_key ?? null,
        resolved_missed_card_ids: resolved_missed_cards.map((c) => Number(c.id)),
        card: {
          kind: 'daily_status',
          severity: status === 'ok' ? 'green' : 'amber',
          title: status === 'ok' ? 'Today looks good' : 'Today needs a little attention',
          lines: [
            facts.sleep_hours != null ? `Sleep: ${facts.sleep_hours}h` : null,
            facts.meds_taken === true
              ? 'Medication: taken'
              : facts.meds_taken === false
                ? 'Medication: not taken (their words)'
                : null,
            facts.activities.length ? `Activity: ${facts.activities.join(', ')}` : null,
            facts.mood < 0 ? 'Mood: sounded low (their words)' : null,
            facts.risk_flags.length ? `Mentioned: ${facts.risk_flags.join(', ')}` : null,
            facts.negated_flags?.length ? `Ruled out by them: ${facts.negated_flags.join(', ')}` : null,
          ].filter(Boolean),
        },
      };
      return { content: json(structured), structuredContent: structured };
    })
  );

  server.registerTool(
    'get_care_journal',
    {
      title: 'Get care journal',
      description:
        'Retrieve the senior\'s longitudinal check-in history for cross-session recall: ' +
        'dates, extracted facts and verbatim excerpts from previous conversations.',
      inputSchema: {
        senior_id: z.string(),
        days: z.number().int().min(1).max(90).default(7),
      },
    },
    audited('get_care_journal', ({ senior_id, days }) => {
      requireSenior(senior_id);
      const since = new Date(new Date(clock.nowIso()).getTime() - days * 86400000).toISOString();
      const entries = store
        .getEvents(senior_id, { type: 'checkin_recorded', sinceTs: since })
        .map((e) => ({
          event_id: Number(e.id),
          date: e.payload.date,
          ts: e.ts,
          excerpt: e.payload.quote,
          facts: e.payload.facts,
        }));
      const structured = { senior_id, days, count: entries.length, entries };
      return { content: json(structured), structuredContent: structured };
    })
  );

  server.registerTool(
    'assess_risk',
    {
      title: 'Assess risk (deterministic)',
      description:
        'Score recent journal events with fixed, transparent rules (risk phrases, missed check-in, ' +
        'low mood, vague replies, recurring topics) over a rolling time window. The returned ' +
        '`escalate` flag means the WINDOW history currently sits at or above the escalation ' +
        'threshold — it is a rolling-window state, not a this-turn decision: it can remain true ' +
        'on a benign new utterance because an earlier adverse event is still inside the window. ' +
        'The caller\'s per-turn signal is the orchestrator\'s `escalated` field: true when THIS ' +
        'message itself qualified for family escalation and the inbox holds the corresponding card ' +
        '— newly created, or reused idempotently on a retry of the same message (`card_created_this_turn` ' +
        'distinguishes the two). ' +
        'This tool never sends anything and this is NOT a medical assessment.',
      inputSchema: {
        senior_id: z.string(),
        window_hours: z.number().min(1).max(24 * 30).default(48),
      },
      outputSchema: z
        .object({
          score: z.number(),
          level: z.enum(['low', 'medium', 'high']),
          escalate: z.boolean(),
          reasons: z.array(z.string()),
        })
        .passthrough(),
    },
    audited('assess_risk', ({ senior_id, window_hours }) => {
      const senior = requireSenior(senior_id);
      const nowIso = clock.nowIso();
      const since = new Date(new Date(nowIso).getTime() - window_hours * 3600000).toISOString();
      const checkins = store.getEvents(senior_id, { type: 'checkin_recorded', sinceTs: since });
      const today = dayStr(nowIso);

      let score = 0;
      const reasons = [];
      // Count each risk-signal TYPE once per window: a chronic condition
      // mentioned on consecutive days is one ongoing signal, not a new
      // emergency each day (recurrence itself is handled by rule R3).
      const uniqueFlags = [...new Set(checkins.flatMap((e) => e.payload.facts?.risk_flags || []))];
      if (uniqueFlags.length) {
        const pts = Math.min(uniqueFlags.length * 3, 9);
        score += pts;
        reasons.push(`risk phrases: ${uniqueFlags.join(', ')} (+${pts})`);
      }
      const negative = checkins.filter((e) => (e.payload.facts?.mood ?? 0) <= -1).length;
      if (negative) {
        const pts = Math.min(negative, 3);
        score += pts;
        reasons.push(`${negative} low-mood check-in(s) in window (+${pts})`);
      }
      // Self-reported missed medication is a mild factual signal (their
      // words, not an inference): it nudges the score but never escalates
      // on its own.
      const medsMissedDays = new Set(
        checkins.filter((e) => e.payload.facts?.meds_taken === false).map((e) => e.payload.date)
      );
      if (medsMissedDays.size) {
        const pts = Math.min(medsMissedDays.size, 2);
        score += pts;
        reasons.push(`medication reported not taken on ${medsMissedDays.size} day(s) (+${pts})`);
      }
      const vagueAfterMiss = checkins.some(
        (e) => e.payload.date === today && e.payload.facts?.vague && (e.payload.facts?.risk_flags || []).length > 0
      );
      if (vagueAfterMiss) {
        score += 2;
        reasons.push('vague, low-detail reply mentioning a risk phrase (+2)');
      }
      const todays = checkins.filter((e) => e.payload.date === today);
      const scheduled = `${today}T${senior.checkin_time}:00.000Z`;
      if (todays.length === 0 && nowIso > scheduled) {
        score += 2;
        reasons.push(`no check-in yet today (scheduled ${senior.checkin_time}) (+2)`);
      }
      const level = score >= 6 ? 'high' : score >= 3 ? 'medium' : 'low';
      const escalate = level === 'high' || (level === 'medium' && uniqueFlags.includes('fall'));
      const structured = {
        senior_id,
        window_hours,
        score,
        level,
        escalate,
        reasons,
        // Additive contract note (same pattern as notify_family): `escalate`
        // is a rolling-window threshold state, not a per-turn send decision.
        escalate_semantics:
          'rolling_window_threshold: true while any adverse event inside the window keeps the score at/above ' +
          'threshold, so it can stay true on a benign new utterance. It never by itself creates a card or sends ' +
          'anything; the per-turn action signal is the orchestrator\'s `escalated` field (with ' +
          '`card_created_this_turn` telling a freshly minted card from an idempotently reused one).',
      };
      store.appendEvent({ ts: nowIso, senior_id, type: 'risk_assessed', payload: structured });
      return { content: json(structured), structuredContent: structured };
    })
  );

  server.registerTool(
    'notify_family',
    {
      title: 'Notify family (inbox only)',
      description:
        'Place a structured, actionable card in the family inbox. KinKeeper NEVER sends external ' +
        'messages — the card waits in the inbox for family to open the app.',
      inputSchema: {
        senior_id: z.string(),
        title: z.string(),
        body: z.string(),
        severity: z.enum(['info', 'green', 'amber']).default('amber'),
        quote: z.string().optional().describe('Verbatim words of the senior that motivate this card'),
        suggested_action: z.string().optional(),
        dedupe_key: z.string().optional().describe('Idempotency key; identical keys create one card'),
      },
    },
    audited('notify_family', ({ senior_id, title, body, severity, quote, suggested_action, dedupe_key }) => {
      requireSenior(senior_id);
      const nowIso = clock.nowIso();
      const key = dedupe_key || `notify:${senior_id}:${nowIso}:${title}`;
      const card = store.addCard({
        created_ts: nowIso,
        senior_id,
        severity,
        title,
        body,
        quote: quote || null,
        suggested_action: suggested_action || null,
        source: { via: 'mcp:notify_family' },
        dedupe_key: key,
      });
      if (card) {
        store.appendEvent({
          ts: nowIso,
          senior_id,
          type: 'family_card_created',
          payload: { card_id: card.id, rule_id: 'mcp:notify_family', severity, title },
        });
      }
      // Idempotent replay: the stored card already exists, so return the
      // ORIGINAL card identity — a replayed call is contractually equivalent
      // to the first one, not a cardless acknowledgment.
      const effective = card || { ...store.getCardByDedupeKey(key), deduplicated: true };
      const structured = {
        delivered_externally: false,
        delivery: 'family_inbox_only',
        note: 'No push, SMS, email or any external message was sent. The card waits in the family inbox.',
        card: effective,
      };
      return { content: json(structured), structuredContent: structured };
    })
  );

  server.registerTool(
    'schedule_followup',
    {
      title: 'Schedule follow-up',
      description:
        'Ask the system to proactively re-engage the senior at a future time ' +
        '(e.g. earlier next morning after a worrying reply).',
      inputSchema: {
        senior_id: z.string(),
        reason: z.string(),
        in_minutes: z.number().min(1).optional(),
        at: z.string().datetime().optional(),
        dedupe_key: z.string().optional(),
      },
    },
    audited('schedule_followup', ({ senior_id, reason, in_minutes, at, dedupe_key }) => {
      requireSenior(senior_id);
      const nowIso = clock.nowIso();
      const due = at || new Date(new Date(nowIso).getTime() + (in_minutes ?? 60) * 60000).toISOString();
      const key = dedupe_key || `followup:${senior_id}:${due}:${reason}`;
      const followup = store.addFollowup({
        senior_id,
        due_ts: due,
        reason,
        created_ts: nowIso,
        dedupe_key: key,
      });
      if (followup) {
        store.appendEvent({
          ts: nowIso,
          senior_id,
          type: 'followup_scheduled',
          payload: { followup_id: followup.id, due_ts: due, reason },
        });
      }
      // Idempotent replay: return the ORIGINAL follow-up's identity. The
      // follow-up IS scheduled (by the first call), so a replay must not
      // report scheduled:false / followup_id:null.
      const original = followup || store.getFollowupByDedupeKey(key);
      const structured = {
        scheduled: Boolean(original),
        deduplicated: !followup,
        due_ts: original?.due_ts ?? due,
        reason: original?.reason ?? reason,
        followup_id: original?.id ?? null,
      };
      return { content: json(structured), structuredContent: structured };
    })
  );

  server.registerTool(
    'get_weekly_digest',
    {
      title: 'Get weekly digest',
      description:
        'Summarize the trailing 7 days: check-in completion, mood trend, recurring topics with ' +
        'verbatim quotes, and risk days — as a structured digest card for family.',
      inputSchema: { senior_id: z.string() },
    },
    audited('get_weekly_digest', ({ senior_id }) => {
      const senior = requireSenior(senior_id);
      const nowIso = clock.nowIso();
      const since = new Date(new Date(nowIso).getTime() - 7 * 86400000).toISOString();
      const checkins = store.getEvents(senior_id, { type: 'checkin_recorded', sinceTs: since });

      const daysWithCheckin = new Set(checkins.map((e) => e.payload.date));
      const moods = checkins.map((e) => e.payload.facts?.mood ?? 0);
      const topicDays = new Map();
      const topicQuote = new Map();
      for (const e of checkins) {
        for (const t of e.payload.facts?.topics || []) {
          if (!topicDays.has(t)) topicDays.set(t, new Set());
          topicDays.get(t).add(e.payload.date);
          if (!topicQuote.has(t)) topicQuote.set(t, e.payload.quote);
        }
      }
      const riskDays = [
        ...new Set(
          checkins.filter((e) => (e.payload.facts?.risk_flags || []).length > 0).map((e) => e.payload.date)
        ),
      ].sort();

      const structured = {
        senior_id,
        period: { from: dayStr(since), to: dayStr(nowIso) },
        checkin_completion: { days_with_checkin: daysWithCheckin.size, out_of: 7 },
        mood_average: moods.length ? Number((moods.reduce((a, b) => a + b, 0) / moods.length).toFixed(2)) : null,
        recurring_topics: [...topicDays.entries()]
          .map(([topic, days]) => ({ topic, days: days.size, example_quote: topicQuote.get(topic) }))
          .sort((a, b) => b.days - a.days),
        risk_days: riskDays,
        card: {
          kind: 'weekly_digest',
          severity: riskDays.length ? 'amber' : 'green',
          title: `Weekly digest — ${senior.display_name}`,
        },
      };
      store.appendEvent({ ts: nowIso, senior_id, type: 'digest_generated', payload: structured });
      return { content: json(structured), structuredContent: structured };
    })
  );

  return server;
}
