// Dana's family action loop and the plain-language "Why this card?" evidence.
// Pure functions over store data: no engineering identifiers, no rule IDs, no
// scores — only observed words, times, and facts from the actual journal.

// The human next steps Dana can record on an escalation / missed-check-in
// card. Clicking a button RECORDS what Dana says she did or plans to do in
// this fictional demo — nothing is called, sent, or concluded.
export const FAMILY_ACTIONS = {
  plan_call: {
    button: 'Plan a call',
    timeline: (name) => `Dana plans to call ${name}`,
  },
  tried_call: {
    button: 'Tried to call',
    timeline: (name) => `Dana said she tried to call`,
  },
  reached: {
    button: 'Reached Maggie',
    timeline: (name) => `Dana said she reached ${name}`,
  },
  follow_up_later: {
    button: 'Follow up later',
    timeline: () => 'Dana will follow up on this later',
  },
};

export const FAMILY_ACTION_TRUTH_NOTE =
  'Recording a step on this page only — no call is placed, no message is sent to Maggie or anyone else, ' +
  'and nothing here is a medical conclusion or an emergency response.';

// The action loop lives on cards that ask family for a human next step:
// escalation cards and missed-check-in cards. Informational cards (recurring
// topic, digest-style notes) stay read-only.
export function isActionableCard(card) {
  const key = String(card?.dedupe_key || '');
  return key.startsWith('escalation:') || key.startsWith('card:missed:');
}

// Actions not yet recorded, minus everything once Maggie was reached — the
// loop is complete at that point and offering more steps would be noise.
export function availableActions(card, recordedActions) {
  if (!isActionableCard(card)) return [];
  const done = new Set((recordedActions || []).map((a) => a.action));
  if (done.has('reached')) return [];
  return Object.keys(FAMILY_ACTIONS).filter((a) => !done.has(a));
}

// The factual, chronological timeline: card created, Maggie's reply if any,
// seen by family (with its real timestamp — never a fabricated one), and
// Dana's recorded steps. Pending states are derived by the client from the
// card's status/source, so this list only ever contains things that happened.
export function buildTimeline(card, recordedActions) {
  const entries = [{ kind: 'created', ts: card.created_ts }];
  if (card.source?.resolved?.by === 'late_checkin' && card.source.resolved.ts) {
    entries.push({ kind: 'replied', ts: card.source.resolved.ts });
  }
  if (card.status === 'acknowledged') {
    // ack_ts is NULL for cards acknowledged before this field existed — the
    // entry is still factual ("seen"), it just honestly has no time.
    entries.push({ kind: 'seen', ts: card.ack_ts || null });
  }
  for (const a of recordedActions || []) {
    entries.push({ kind: 'action', ts: a.created_ts, action: a.action });
  }
  const order = { created: 0, replied: 1, seen: 2, action: 3 };
  return entries.sort((a, b) => {
    const ta = a.ts || '9999';
    const tb = b.ts || '9999';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return order[a.kind] - order[b.kind];
  });
}

const hm = (iso) => (iso ? iso.slice(11, 16) : null);

const fmtDay = (dateStr) =>
  new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

const fmtDayList = (dates) => dates.map(fmtDay).join(', ');

// Plain-language explanation of why a card exists, built from the actual
// journal and the card's own stored facts. It quotes Maggie exactly when a
// quote exists, states observed timing/check-in/reply facts, and adds at most
// relevant 7-day context. It never re-interprets risk and never exposes rule
// IDs, scores, or audit internals.
//
// The 7-day context window is anchored at the card's creation, never at
// "now": why-it-fired evidence must describe what was true when KinKeeper
// placed the card. Later events belong to the card's timeline (and to factual
// body updates like the late-reply resolution), not to its creation
// rationale — otherwise a next-day event would retroactively rewrite the
// explanation of an old card.
export function buildWhy({ store, card, senior }) {
  const name = senior?.display_name || 'Maggie';
  const why = { summary: '', quote: card.quote || null, facts: [], context: [] };
  const key = String(card.dedupe_key || '');
  const since = new Date(new Date(card.created_ts).getTime() - 7 * 86400000).toISOString();
  const week = store
    .getEvents(card.senior_id, { type: 'checkin_recorded', sinceTs: since })
    .filter((e) => e.ts <= card.created_ts);

  if (key.startsWith('card:missed:')) {
    why.summary = `${name} had not checked in by her usual morning time when this card was created.`;
    why.facts.push(
      `Her check-in is due at ${senior.checkin_time} each morning; KinKeeper waits a ${senior.grace_minutes}-minute grace before it speaks up.`,
      `This card was created at ${hm(card.created_ts)} UTC, when no check-in had arrived.`
    );
    if (card.source?.resolved?.by === 'late_checkin') {
      why.facts.push(`${name} has since replied — the late check-in was recorded at ${hm(card.source.resolved.ts)} UTC.`);
    } else {
      why.facts.push('No reply has been recorded yet, so KinKeeper is still waiting to hear from her.');
    }
    const days = [...new Set(week.map((e) => e.payload.date))].sort();
    if (days.length) {
      why.context.push(`In the past 7 days she checked in on ${days.length} day${days.length === 1 ? '' : 's'}: ${fmtDayList(days)}.`);
    } else {
      why.context.push('There are no check-ins in the past 7 days of her journal.');
    }
    return why;
  }

  if (key.startsWith('escalation:')) {
    const eventId = Number(key.split(':')[2]);
    const event = Number.isFinite(eventId) ? store.getEvent(eventId) : null;
    const facts = event?.payload?.facts || {};
    const flags = facts.risk_flags || [];
    let signal = null;
    if (flags.length) signal = 'risk';
    else if (facts.meds_taken === false) signal = 'meds';
    else if ((facts.mood ?? 0) < 0) signal = 'mood';

    if (signal === 'risk') {
      why.summary = `${name} said something worrying in her own words, so KinKeeper placed this card for family to check on her.`;
      why.facts.push(`Her message mentioned: ${flags.join(', ')}.`);
    } else if (signal === 'meds') {
      why.summary = `${name} said in her own words that her medication was not taken.`;
      why.facts.push('She said her medication was not taken — her own words, quoted on this card.');
    } else if (signal === 'mood') {
      why.summary = `${name} sounded low in her check-in.`;
      why.facts.push('Her own words sounded low to KinKeeper.');
    } else {
      why.summary = 'KinKeeper placed this card after hearing something it flags for family attention.';
    }
    why.facts.push('KinKeeper repeats what she said — it cannot tell how serious this is, and this is not a medical assessment.');

    // At most relevant 7-day context: earlier days whose journal facts share
    // this card's signal, stated as plain observations.
    const prior = week.filter((e) => Number(e.id) !== eventId);
    if (signal === 'risk') {
      for (const flag of flags.slice(0, 2)) {
        const days = [...new Set(prior.filter((e) => (e.payload.facts?.risk_flags || []).includes(flag)).map((e) => e.payload.date))].sort();
        if (days.length) why.context.push(`She also mentioned “${flag}” on ${fmtDayList(days)}.`);
      }
    } else if (signal === 'meds') {
      const days = [...new Set(prior.filter((e) => e.payload.facts?.meds_taken === false).map((e) => e.payload.date))].sort();
      if (days.length) why.context.push(`She also said her medication was not taken on ${fmtDayList(days)}.`);
    } else if (signal === 'mood') {
      const days = [...new Set(prior.filter((e) => (e.payload.facts?.mood ?? 0) < 0).map((e) => e.payload.date))].sort();
      if (days.length) why.context.push(`Her check-in sounded low on ${fmtDayList(days)} as well.`);
    }
    why.context = why.context.slice(0, 3);
    return why;
  }

  if (card.source?.rule_id === 'R3_REPEATED_TOPIC' && card.source.topic) {
    const topic = card.source.topic;
    const days = [...(card.source.days || [])].sort();
    why.summary = `“${topic}” has come up on several different days recently.`;
    if (days.length) why.facts.push(`It was mentioned on ${fmtDayList(days)}.`);
    why.facts.push('A gentle mention on the next call is enough — this is a conversation prompt, not a warning.');
    return why;
  }

  why.summary = 'KinKeeper placed this card in the family inbox.';
  why.facts.push(`It was created at ${hm(card.created_ts)} UTC.`);
  return why;
}
