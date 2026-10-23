// Deterministic care rules. Pure functions: same inputs -> same outputs.
// The scheduler evaluates these on a tick; the demo fast-forward only moves
// the clock, it never special-cases rule logic.

export function dayStr(iso) {
  return iso.slice(0, 10); // YYYY-MM-DD of the virtual timestamp
}

export function scheduledCheckinIso(dateStr, checkinTime) {
  return `${dateStr}T${checkinTime}:00.000Z`;
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60000).toISOString();
}

// R1 — MISSED_CHECKIN
// If the scheduled check-in time + grace has passed for the current day and
// no check-in event exists for that day, the system must (a) prompt the
// senior proactively and (b) place an actionable card in the family inbox.
export function evaluateMissedCheckin({ senior, checkinEvents, nowIso }) {
  const today = dayStr(nowIso);
  const scheduled = scheduledCheckinIso(today, senior.checkin_time);
  const deadline = addMinutes(scheduled, senior.grace_minutes);
  if (nowIso < scheduled) return []; // not yet due
  const todays = checkinEvents.filter((e) => e.payload.date === today);
  if (todays.length > 0) return [];
  const missed = nowIso >= deadline;
  return [
    {
      kind: 'proactive',
      rule_id: 'R1_MISSED_CHECKIN',
      dedupe_key: `proactive:missed:${today}`,
      reason: missed
        ? `No check-in by ${senior.checkin_time} (+${senior.grace_minutes}m grace)`
        : `Check-in time ${senior.checkin_time} reached`,
    },
    ...(missed
      ? [
          {
            kind: 'card',
            rule_id: 'R1_MISSED_CHECKIN',
            dedupe_key: `card:missed:${today}`,
            severity: 'amber',
            title: `Missed check-in — ${senior.display_name}`,
            body: `${senior.display_name} had not checked in by ${senior.checkin_time} plus a ${senior.grace_minutes}-minute grace period. KinKeeper has proactively asked how they are and is awaiting a reply.`,
            quote: null,
            suggested_action: `Give ${senior.display_name} a call today to say hello and confirm all is well.`,
            source: { rule_id: 'R1_MISSED_CHECKIN', deadline },
          },
        ]
      : []),
  ];
}

// R3 — REPEATED_TOPIC
// A watched concern mentioned on >= threshold distinct days inside the
// trailing window is surfaced as an info card (longitudinal signal).
export function evaluateRepeatedTopics({ senior, checkinEvents, nowIso, windowDays = 7, threshold = 3 }) {
  const since = new Date(new Date(nowIso).getTime() - windowDays * 86400000).toISOString();
  const recent = checkinEvents.filter((e) => e.ts >= since);
  const byTopic = new Map();
  for (const e of recent) {
    for (const topic of e.payload.facts?.topics || []) {
      if (!byTopic.has(topic)) byTopic.set(topic, new Set());
      byTopic.get(topic).add(e.payload.date);
    }
  }
  const actions = [];
  for (const [topic, days] of byTopic) {
    if (days.size >= threshold) {
      const week = dayStr(nowIso);
      actions.push({
        kind: 'card',
        rule_id: 'R3_REPEATED_TOPIC',
        dedupe_key: `card:repeat:${topic}:${week}`,
        severity: 'info',
        title: `Recurring topic: "${topic}"`,
        body: `"${topic}" came up on ${days.size} different days in the past ${windowDays} days (${[...days].sort().join(', ')}). Worth a gentle mention next time you talk.`,
        quote: null,
        suggested_action: `Ask ${senior.display_name} about "${topic}" on your next call.`,
        source: { rule_id: 'R3_REPEATED_TOPIC', topic, days: [...days].sort() },
      });
    }
  }
  return actions;
}

export function evaluateRules(ctx) {
  return [...evaluateMissedCheckin(ctx), ...evaluateRepeatedTopics(ctx)];
}
