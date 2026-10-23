// Pure predicates behind the Explore-the-demo guided steps, kept separate
// from app.js so they are unit-testable in Node without a DOM.
//
// The "Maggie answers vaguely about a fall" step describes one specific
// moment: THIS message (a) newly escalated, (b) mentioned a fall, and
// (c) was vague/low-detail. `r.escalated` alone is too broad — a genuinely
// escalated missed-meds or low-mood message is also a true current
// escalation, but it is not the vague-fall moment the step copy promises.
export function isVagueFallEscalation(r) {
  if (!r || r.escalated !== true) return false;
  const facts = r.facts || {};
  return (
    Array.isArray(facts.risk_flags) &&
    facts.risk_flags.includes('fall') &&
    facts.vague === true
  );
}
