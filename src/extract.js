// Deterministic transcript fact extraction.
// No LLM, no network: a transparent rule parser so every fact shown in the
// demo can be traced back to the exact words the (synthetic) senior said.
//
// Negation-aware: assertions are evaluated per clause, and a keyword that is
// explicitly negated ("I did NOT fall", "no chest pain", "had NOT taken my
// meds") is never reported as a positive fact. Negated mentions are reported
// separately as `negated_flags` so the UI can show what was ruled out instead
// of silently dropping the words.

const RISK_LEXICON = [
  { flag: 'fall', pattern: /\b(fell|fall(en)?|slipped|tripped)\b/i },
  { flag: 'pain', pattern: /\b(pain|hurt(?:s|ing)?|aching|ache|sore)\b/i },
  { flag: 'dizzy', pattern: /\b(dizzy|lightheaded|faint)\b/i },
  { flag: 'chest', pattern: /\b(chest)\b/i },
  { flag: 'confused', pattern: /\b(confused|forget(ting)?|can'?t remember|mixed up)\b/i },
];

const POSITIVE = /\b(good|great|fine|well|okay|ok|lovely|wonderful|slept well)\b/i;
const NEGATIVE = /\b(tired|exhausted|lonely|sad|bad|terrible|awful|rough|poorly)\b/i;

const MED_NOUN = /\b(meds?|medications?|pills?|tablets?)\b/i;
const MED_VERB = /\b(took|taken|take|takes|taking|had)\b/i;
const MED_MISSED = /\b(forgot|forgotten|skipped|missed)\b/i;

const NEGATION_WORDS = /\b(no|not|never|without|deny|denies|denied)\b|\b\w+n't\b/i;
// How many words before a keyword a negation cue can still govern it.
// "I have not had any chest pain" -> "not" is 3 words before "chest".
const NEGATION_WINDOW_WORDS = 4;

// Clause boundaries: sentence punctuation and contrastive/coordinating
// conjunctions, so a negation in one clause never leaks into the next
// ("I have no pain and I fell" — the fall is real, the pain is denied).
function splitClauses(text) {
  return text
    .split(/[.!?;…]+|\bbut\b|\bthough\b|\bhowever\b|\band\b|\b(?:or|nor)\s+(?=(?:i|we|you|he|she|they|it)\b)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// True when a negation cue appears within NEGATION_WINDOW_WORDS before the
// match at matchIndex inside the same clause.
function isNegated(clause, matchIndex) {
  const before = clause.slice(0, matchIndex).trim();
  if (!before) return false;
  const words = before.split(/\s+/).filter(Boolean);
  const window = words.slice(-NEGATION_WINDOW_WORDS).join(' ');
  return NEGATION_WORDS.test(window);
}

// Keep each occurrence, including a later affirmation after an earlier denial.
function occurrencesInClauses(clauses, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const hits = [];
  for (const clause of clauses) {
    const re = new RegExp(pattern.source, flags);
    let previous = null;
    let match;
    while ((match = re.exec(clause)) !== null) {
      // A bare "or fall"/"or pain" continues the preceding negated list item.
      const coordinated = previous?.negated && /\b(?:or|nor)\s*$/i.test(clause.slice(previous.end, match.index));
      const negated = isNegated(clause, match.index) || !!coordinated;
      hits.push({ clause, index: match.index, negated });
      previous = { negated, end: re.lastIndex };
      if (match[0].length === 0) re.lastIndex += 1;
    }
  }
  return hits;
}

function extractMeds(clauses) {
  let mentioned = false;
  let sawTaken = false;
  let sawNotTaken = false;
  for (const clause of clauses) {
    const noun = clause.match(MED_NOUN);
    if (!noun) continue;
    mentioned = true;
    const negatedNoun = isNegated(clause, noun.index ?? 0);
    const verb = clause.match(MED_VERB);
    const missed = clause.match(MED_MISSED);
    if (missed || negatedNoun) {
      sawNotTaken = true;
    } else if (verb && !isNegated(clause, verb.index ?? 0)) {
      sawTaken = true;
    }
    // Meds mentioned with no take/negation cue -> mentioned, status unknown.
  }
  // Explicit "taken" wins over a separate negated clause only if both exist;
  // ambiguous mixes resolve to the affirmative statement the senior made.
  const meds_taken = sawTaken ? true : sawNotTaken ? false : null;
  return { meds_taken, meds_mentioned: mentioned };
}

export function extractFacts(transcript, watchedConcerns = []) {
  const text = String(transcript || '');
  const clauses = splitClauses(text);

  let sleep_hours = null;
  const sleepMatch = text.match(/slept\s+(?:for\s+)?(?:about\s+)?(\d{1,2}(?:\.\d)?)/i)
    || text.match(/(\d{1,2}(?:\.\d)?)\s*(?:hours?|hrs?|h)\s+(?:of\s+)?sleep/i);
  if (sleepMatch) sleep_hours = Number(sleepMatch[1]);

  const { meds_taken, meds_mentioned } = extractMeds(clauses);

  const activities = [];
  const ACTIVITY_PATTERNS = [
    [/\b(walk(?:ed|ing)?|stroll(?:ed)?)\b/i, 'walk'],
    [/\bdog\b/i, 'dog'],
    [/\bgarden(?:ed|ing)?\b/i, 'gardening'],
    [/\b(yoga|tai\s*chi|stretch(?:ed|ing)?)\b/i, 'exercise'],
    [/\b(called|phoned|spoke (?:to|with))\b/i, 'social call'],
  ];
  for (const [pattern, label] of ACTIVITY_PATTERNS) {
    if (activities.includes(label)) continue;
    const hits = occurrencesInClauses(clauses, pattern);
    // A negated earlier mention does not erase a later clear activity.
    if (hits.some((hit) => !hit.negated)) activities.push(label);
  }

  const risk_flags = [];
  const negated_flags = [];
  for (const { flag, pattern } of RISK_LEXICON) {
    const hits = occurrencesInClauses(clauses, pattern);
    if (!hits.length) continue;
    const affirmed = hits.some((hit) => !hit.negated);
    // Any clear affirmative occurrence is retained. The flag is "ruled out"
    // only when every occurrence is negated, so a mixed sentence is not
    // summarized as both mentioned and ruled out. The verbatim quote still
    // carries both clauses. shortcut: other negation forms use the existing
    // 4-word window; extend the parser when supported transcripts require it.
    if (affirmed) risk_flags.push(flag);
    else negated_flags.push(flag);
  }

  const topics = watchedConcerns.filter((concern) => {
    const words = concern.toLowerCase().split(/\s+/);
    return words.some((w) => w.length > 2 && text.toLowerCase().includes(w));
  });

  // Mood: a negated sentiment word counts for nothing ("not good" is not a
  // wellness assertion, "not bad" is not a complaint).
  let posHit = false;
  let negHit = false;
  for (const clause of clauses) {
    const p = clause.match(POSITIVE);
    if (p && !isNegated(clause, p.index ?? 0)) posHit = true;
    const n = clause.match(NEGATIVE);
    if (n && !isNegated(clause, n.index ?? 0)) negHit = true;
  }
  let mood = 0;
  if (posHit) mood += 1;
  if (negHit) mood -= 1;
  if (risk_flags.length > 0) mood -= 1;
  mood = Math.max(-2, Math.min(2, mood));

  // Vague / low-detail reply: very short, hedged, or trailing off.
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const vague =
    wordCount <= 8 ||
    /\.\.\.|…/.test(text) ||
    /\b(i don'?t know|never mind|nothing|i'?m fine[,.\s]*$|whatever)\b/i.test(text);

  return {
    sleep_hours,
    meds_taken, // true | false (explicitly not taken) | null (not mentioned)
    meds_mentioned,
    activities,
    risk_flags,
    negated_flags,
    topics,
    mood,
    vague,
    word_count: wordCount,
  };
}
