// The simulated Alexa+ companion. Deterministic by design: templated
// dialogue + the shared fact extractor, reaching care capability ONLY via
// real MCP tool calls. No LLM, no external API — every turn is auditable.
import { createHash } from 'node:crypto';
import { dayStr } from './rules.js';

const fmtDay = (dateStr) =>
  new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

function greeting(name, nowIso) {
  const hour = Number(nowIso.slice(11, 13));
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  return `Good ${part}, ${name}.`;
}

function acknowledgements(facts) {
  const bits = [];
  if (facts.sleep_hours != null) {
    bits.push(
      facts.sleep_hours >= 7
        ? `${facts.sleep_hours} hours of sleep — that's a solid night`
        : `${facts.sleep_hours} hours of sleep — a bit on the short side`
    );
  }
  if (facts.meds_taken) bits.push('medication taken');
  const ACTIVITY_PHRASES = {
    walk: 'a walk',
    dog: 'time with the dog',
    gardening: 'a little gardening',
    exercise: 'some exercise',
    'social call': 'a nice call',
  };
  if (facts.activities.length) {
    bits.push(facts.activities.map((a) => ACTIVITY_PHRASES[a] || a).join(' and '));
  }
  return bits;
}

export function createOrchestrator({ store, clock, mcp }) {
  const firstName = (senior) => senior.display_name.split(' ')[0];

  async function handleMessage(seniorId, message) {
    const senior = store.getSenior(seniorId);
    if (!senior) throw new Error(`unknown senior_id "${seniorId}"`);
    const name = firstName(senior);
    const nowIso = clock.nowIso();
    const toolCalls = [];

    const rec = await mcp.callTool('record_checkin', {
      senior_id: seniorId,
      transcript: message,
      // Stable idempotency key: same senior, same day, same words -> the same
      // check-in. A retried tool call (or an accidental double submit) can
      // never double-record the journal entry or re-trigger downstream cards.
      idempotency_key: createHash('sha256')
        .update(`${seniorId}|${dayStr(nowIso)}|${message}`)
        .digest('hex')
        .slice(0, 24),
    });
    toolCalls.push('record_checkin');
    if (rec.isError) throw new Error('record_checkin failed');
    const checkin = rec.structuredContent;
    const facts = checkin.facts;

    const journal = await mcp.callTool('get_care_journal', { senior_id: seniorId, days: 7 });
    toolCalls.push('get_care_journal');
    const entries = journal.structuredContent?.entries || [];

    // Cross-session recall: prior days that mentioned today's topics.
    const recall = [];
    for (const topic of facts.topics || []) {
      const prior = entries.filter(
        (e) => e.date !== checkin.date && (e.facts?.topics || []).includes(topic)
      );
      if (prior.length > 0) {
        const days = [...new Set(prior.map((e) => e.date))].sort();
        recall.push({
          topic,
          prior_dates: days,
          mention_count_including_today: days.length + 1,
          line: `You've mentioned your ${topic} before — on ${days.map(fmtDay).join(' and ')}. That's ${days.length + 1} times this week.`,
        });
      }
    }

    const risk = await mcp.callTool('assess_risk', { senior_id: seniorId, window_hours: 72 });
    toolCalls.push('assess_risk');
    const assessment = risk.structuredContent;

    // Current-message actionable adverse signal, kept distinct from the
    // historical 72h assessment. The assessment intentionally stays elevated
    // after yesterday's risk (it is the journal/audit record), but a NEW
    // family escalation is only truthful when THIS message itself carries
    // something adverse. A benign reply today must never mint a fresh worry
    // card quoting benign words or claim this utterance was worrying.
    const currentSignal =
      facts.risk_flags.length > 0
        ? 'risk'
        : facts.meds_taken === false
          ? 'meds'
          : facts.mood < 0
            ? 'mood'
            : null;
    const escalateNow = Boolean(assessment?.escalate && currentSignal);

    const ESCALATION_BODY = {
      risk: `${senior.display_name} mentioned something worrying in today's check-in — her exact words are quoted on this card. KinKeeper repeats what was said and cannot tell how serious it is. This is a prompt for a caring call, not a medical assessment.`,
      meds: `${senior.display_name} said in her own words today that her medication was not taken — her exact words are quoted on this card. KinKeeper repeats what was said and cannot tell how serious it is. This is a prompt for a caring call, not a medical assessment.`,
      mood: `${senior.display_name} sounded low in today's check-in — her exact words are quoted on this card. KinKeeper repeats what was said and cannot tell how serious it is. This is a prompt for a caring call, not a medical assessment.`,
    };
    const ESCALATION_ACTION = {
      risk: `Call ${name} today. Ask how the ${facts.risk_flags[0] || 'day'} is, and whether anything is needed around the house.`,
      meds: `Call ${name} today. Ask whether the medication routine is back on track, and whether anything is needed around the house.`,
      mood: `Call ${name} today. Ask how she is feeling, and whether anything is needed around the house.`,
    };

    let escalationCard = null;
    if (escalateNow) {
      const familyLine = senior.family_contact || 'your family';
      const notify = await mcp.callTool('notify_family', {
        senior_id: seniorId,
        title: `Please check on ${senior.display_name} today`,
        // Product-facing wording only — the technical scoring rationale stays
        // in the escalation_completed event payload below, never on the card.
        body: ESCALATION_BODY[currentSignal],
        severity: 'amber',
        quote: checkin.transcript,
        suggested_action: ESCALATION_ACTION[currentSignal],
        dedupe_key: `escalation:${checkin.date}:${checkin.event_id}`,
      });
      toolCalls.push('notify_family');
      escalationCard = notify.structuredContent?.card || null;

      await mcp.callTool('schedule_followup', {
        senior_id: seniorId,
        reason: `Earlier follow-up after flagged check-in on ${checkin.date}`,
        in_minutes: 60,
        dedupe_key: `esc-followup:${checkin.event_id}`,
      });
      toolCalls.push('schedule_followup');
      store.appendEvent({
        ts: nowIso,
        senior_id: seniorId,
        type: 'escalation_completed',
        payload: { event_id: checkin.event_id, family_line: familyLine, risk: assessment },
        // Idempotent per stable check-in event: replaying the same message
        // returns the deduplicated card/follow-up and must NOT append a second
        // completion record. A genuinely new check-in has a new event_id, so
        // its escalation is still recorded exactly once.
        dedupe_key: `esc-completed:${checkin.event_id}`,
      });
    }

    // Compose the companion's reply.
    const parts = [greeting(name, nowIso)];
    const acks = acknowledgements(facts);
    if (acks.length && !escalateNow) {
      parts.push(`Lovely to hear — ${acks.join(', ')}.`);
    } else if (acks.length) {
      parts.push(`Thank you for telling me — ${acks.join(', ')}.`);
    }
    for (const r of recall) parts.push(r.line);
    if (facts.meds_taken === false && !escalateNow) {
      // Explicitly stated, so it is safe to reflect back — never inferred.
      parts.push(`You mentioned you hadn't taken your medication today — I've made a note of that in the journal.`);
    }
    if (facts.mood < 0 && !escalateNow && !facts.risk_flags.length) {
      // A low-mood day is reflected gently and without any diagnosis: KinKeeper
      // acknowledges what was said, notes the journal, and points to people —
      // never to a notification it did not send or help it cannot provide.
      parts.push(
        `I'm sorry today feels heavy. Thank you for telling me — I've made a note of how you're feeling in the journal, just as you said it. ` +
        `If the low feeling stays with you, it can help to share it with someone close to you. I'm only a companion — this isn't medical advice.`
      );
    }
    if (escalateNow && currentSignal === 'risk') {
      parts.push(
        `I'm sorry, that sounds worrying. I've left a note for ${senior.family_contact || 'your family'} so someone checks in with you today, and I'll come back a little earlier to see how you are.`
      );
      parts.push(
        `One important thing: I'm only a companion demo — I can't get help in an emergency. If you feel unwell or unsafe, please call your local emergency number right away.`
      );
    } else if (escalateNow) {
      parts.push(
        `Thank you for telling me. I've left a note for ${senior.family_contact || 'your family'} so someone checks in with you today, and I'll come back a little earlier to see how you are.`
      );
    } else if (facts.risk_flags.length) {
      parts.push(
        `I've made a note of that so we can keep an eye on it together. If it gets worse, please do tell someone — and remember I'm only a companion, not medical help.`
      );
    } else if (facts.mood < 0) {
      parts.push(
        `I'll be here whenever you want to talk, and I'll check in with you again at ${senior.checkin_time}. Be gentle with yourself today, ${name}.`
      );
    } else {
      parts.push(`I'll check in with you again at ${senior.checkin_time}. Have a good day, ${name}.`);
    }

    const reply = parts.join(' ');
    store.appendEvent({
      ts: nowIso,
      senior_id: seniorId,
      type: 'companion_turn',
      payload: { user: message, reply, tool_calls: toolCalls, recall },
    });
    return {
      reply,
      facts,
      recall,
      risk: assessment,
      // True when THIS message itself qualified for family escalation — the
      // historical `risk.escalate` can stay true for 72h after a real event,
      // so UI must key per-turn escalation off this flag, not the score. The
      // inbox holds the corresponding card either way: on an idempotent
      // replay of the same message, notify_family returns the ORIGINAL card
      // (card.deduplicated: true), so `escalated` does NOT by itself mean a
      // new card was created this turn.
      escalated: escalateNow,
      // Additive precision for the above: true only when this turn actually
      // minted the escalation card (first delivery, not a deduplicated retry).
      card_created_this_turn: Boolean(escalationCard && !escalationCard.deduplicated),
      tool_calls: toolCalls,
      cards: [checkin.card, ...(escalationCard ? [escalationCard] : [])],
    };
  }

  // Proactive openers queued by the scheduler (missed check-in / follow-ups).
  // The reason queued by the rule or the schedule_followup tool decides BOTH
  // the copy and the reported kind, so a risk follow-up never reuses the
  // generic "hadn't heard from you yet today" missed-check-in wording.
  function classifyProactive(reason = '') {
    return /no check-in|check-in time/i.test(reason) ? 'missed_checkin' : 'risk_followup';
  }

  function proactiveCopy(kind, name, nowIso) {
    if (kind === 'risk_followup') {
      return (
        `${greeting(name, nowIso)} I'm checking back in, as I promised after our earlier conversation. ` +
        `How are you feeling now — has anything changed since we last spoke?`
      );
    }
    return (
      `${greeting(name, nowIso)} I hadn't heard from you yet today, so I wanted to check — ` +
      `how are you feeling? Did you sleep alright?`
    );
  }

  const servedKey = (seniorId) => `served_prompts:${seniorId}`;

  // Peek at the next pending prompt WITHOUT consuming it. Reading must not
  // change state; the companion acknowledges via ackProactive once it has
  // actually spoken the prompt to the senior.
  function getProactive(seniorId) {
    const senior = store.getSenior(seniorId);
    if (!senior) return { prompt: null };
    const served = new Set(JSON.parse(store.getConfig(servedKey(seniorId)) || '[]'));
    const pending = store
      .getEvents(seniorId, { type: 'proactive_prompt' })
      .filter((e) => !served.has(Number(e.id)));
    if (pending.length === 0) return { prompt: null };

    const event = pending[0];
    const kind = classifyProactive(event.payload.reason);
    return {
      prompt: proactiveCopy(kind, firstName(senior), clock.nowIso()),
      reason: event.payload.reason,
      kind,
      event_id: Number(event.id),
      spoken: false,
    };
  }

  // Idempotent: acknowledging the same prompt twice is a no-op.
  function ackProactive(seniorId, eventId) {
    const senior = store.getSenior(seniorId);
    if (!senior) throw new Error(`unknown senior_id "${seniorId}"`);
    const key = servedKey(seniorId);
    const served = new Set(JSON.parse(store.getConfig(key) || '[]'));
    const id = Number(eventId);
    if (served.has(id)) return { served: true, already: true };
    const event = store.getEvents(seniorId, { type: 'proactive_prompt' }).find((e) => Number(e.id) === id);
    if (!event) return { served: false, error: 'no such pending prompt' };
    served.add(id);
    store.setConfig(key, JSON.stringify([...served]));
    const kind = classifyProactive(event.payload.reason);
    const nowIso = clock.nowIso();
    store.appendEvent({
      ts: nowIso,
      senior_id: seniorId,
      type: 'companion_turn',
      payload: { proactive: true, kind, reason: event.payload.reason, reply: proactiveCopy(kind, firstName(senior), nowIso), tool_calls: [] },
    });
    store.audit({
      ts_virtual: nowIso,
      direction: 'system',
      method: 'companion.proactive_spoken',
      detail: { event_id: id, kind, reason: event.payload.reason },
    });
    return { served: true, already: false, kind };
  }

  async function getDigest(seniorId) {
    const res = await mcp.callTool('get_weekly_digest', { senior_id: seniorId });
    return res.structuredContent;
  }

  return { handleMessage, getProactive, ackProactive, getDigest };
}
