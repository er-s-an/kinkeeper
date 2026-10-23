# KinKeeper — proactive care-coordination companion (Alexa+ track demo)

> **Safety notice — read first.**
> KinKeeper is a **synthetic care-coordination demo**. The senior ("Maggie Rivera") is a
> **fictional persona** and every check-in, quote and card is **generated locally from
> invented text**. KinKeeper is **not a medical device**, provides **no medical diagnosis,
> monitoring or advice**, and **cannot contact emergency services**. It **never sends real
> notifications** — no push, SMS, email or voice call ever leaves this machine; family
> "notifications" are cards that wait in a local inbox page. It uses **no real personal
> data, no credentials, no paid APIs, and no external network calls**.

Built for the **Amazon Developer Hackathon — Alexa+ track**: a **self-hosted MCP server**
(Model Context Protocol **spec 2025-11-25** over **Streamable HTTP**) plus a **web-simulated
Alexa+ experience**, as explicitly permitted by the track rules.

## What it does

KinKeeper closes a proactive care loop for a senior living alone — nobody has to ask:

1. **Scheduled daily check-in.** The companion greets the senior each morning; what they
   say is recorded into a longitudinal care journal via the MCP tool `record_checkin`.
2. **Cross-session memory.** The companion recalls prior days verbatim:
   *"You've mentioned your knee before — on Thursday, Oct 1 and Friday, Oct 2."*
3. **Deterministic rules, not vibes.** A rules engine (R1 missed-check-in, R3
   repeated-topic) runs against the event store on a scheduler tick. When the 09:00
   check-in plus a 45-minute grace passes with no word, the rule fires — deterministically.
4. **The system speaks first.** After a missed check-in the companion proactively opens:
   *"I hadn't heard from you yet today — how are you feeling?"*
5. **Actionable family inbox.** A vague reply mentioning a fall escalates via
   `assess_risk` → `notify_family` → an amber card with the senior's **verbatim quote**
   and a suggested action ("Call Maggie today"). The card waits in the local inbox;
   nothing is ever sent externally.
6. **Weekly digest.** `get_weekly_digest` summarizes completion, mood trend, recurring
   topics with quotes, and risk days.

## Architecture

```
┌─────────────────────────────── one local Node process ───────────────────────────────┐
│                                                                                      │
│  public/ (web)          src/orchestrator.js        src/mcp/server.js                 │
│  Simulated Alexa+  ──▶  Simulated companion  ──▶   MCP server (6 tools)              │
│  chat / inbox /         (deterministic             record_checkin                    │
│  journal / audit        dialogue engine)           get_care_journal                  │
│        │                      │                    assess_risk                       │
│        │ REST /api/*          │ MCP client         notify_family                     │
│        ▼                      ▼ (official SDK,     schedule_followup                 │
│  ┌───────────────────────────────────────────▶    get_weekly_digest                  │
│  │  POST/GET/DELETE /mcp — Streamable HTTP, spec 2025-11-25, stateful sessions  │    │
│  └──────────────────────────────────────────────────────────────────────────────┘    │
│        │                                                                             │
│  src/scheduler.js (proactive ticks) ──▶ src/rules.js (deterministic R1/R3)           │
│        │                                                                             │
│        ▼                                                                             │
│  src/store.js — SQLite event store: events · inbox_cards · followups · audit         │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

The companion reaches care capability **only through the MCP protocol** — an independent
MCP client (or the official MCP Inspector) can call the same six tools at
`http://localhost:8787/mcp`. Every JSON-RPC call is persisted to the audit trail
(`mcp-in` / `mcp-out` / `system` rows), available via `GET /api/audit`. The showcased
web UI (Today / Family updates / Safety / Explore the demo) deliberately keeps this
protocol evidence out of the product views; this README, the tests, and the audit API
are the technical proof.

The web UI's conversation pane is session-only (it clears on reload, and the Safety
view says so); the journal, family cards, follow-ups, and audit trail persist in SQLite.

## Quick start

**Requires Node.js 22** (developed on Node 22 / macOS arm64). `better-sqlite3` is a
**native module compiled for a specific Node.js major version** — if you switch Node
versions you will see `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch errors. Fix by
running KinKeeper with Node 22, or rebuild the module for your current Node:

```bash
npm rebuild better-sqlite3
```

No accounts, keys or network access needed beyond `npm install`.

```bash
npm install
npm start          # serves everything on http://localhost:8787 (loopback only)
```

Open **http://localhost:8787/** — the first screen is Maggie's **Today** view with her
check-in status and one clear action. The **Explore the demo** view walks the two-minute
story in plain language (check-in → quiet morning → KinKeeper speaks first → vague fall
reply → amber family card → weekly summary); Dana's cards live under **Family updates**,
and **Safety** states the fictional-data, no-notification, no-emergency, and
no-medical-advice limits.

```bash
npm test           # unit tests: deterministic rules + fact extractor + idempotency
npm run verify     # end-to-end: independent MCP client, full scenario, restart persistence
npm run seed       # reseed synthetic data (add -- --reset to wipe and reseed)
```

## Network binding & access control

The server binds to **127.0.0.1 (loopback only) by default**, because the demo exposes
raw journal/audit reads, MCP writes, reset and time-warp endpoints. To bind beyond
localhost you must opt in explicitly **and** set a bearer token — the server refuses to
start otherwise:

```bash
KINKEEPER_HOST=0.0.0.0 KINKEEPER_TOKEN=choose-a-token npm start
```

With a broad bind, every `/api/*` and `/mcp` request from a non-loopback client must send
`Authorization: Bearer <KINKEEPER_TOKEN>`; loopback clients stay unrestricted. Static
assets remain public (they contain no data). Even with a token, this is a hackathon demo —
do not expose it to the public internet.

## Idempotency & negation handling

- **Mutating MCP tools are idempotent.** `record_checkin` accepts an `idempotency_key`;
  `notify_family` and `schedule_followup` accept `dedupe_key`. A replayed call returns the
  originally recorded event/card/follow-up — including its original ID — instead of
  creating a duplicate or answering with a cardless acknowledgment. The built-in MCP
  client (`src/mcp/client.js`) only retries a failed call when it is truly
  side-effect-free **or** carries such a key — everything else fails honestly instead
  of being re-sent. The orchestrator's `escalation_completed` audit event likewise
  carries a per-check-in dedupe key (`esc-completed:<event_id>`), so replaying the same
  message returns the deduplicated card/follow-up without appending a second completion
  record, while a genuinely new check-in is still recorded exactly once.
- **Audit-producing reads are not silently retried.** `get_care_journal` is the only
  side-effect-free tool. `get_weekly_digest` and `assess_risk` compute from read-only
  data but deliberately append an audit event on every call (`digest_generated` /
  `risk_assessed`) so the demo can show real usage; because of that they are *not*
  classified as safe-to-retry, and repeated calls honestly produce repeated audit
  events rather than pretending to be pure reads.
- **Fact extraction is negation-aware** (`src/extract.js`). Statements are parsed per
  clause: "I did not fall and I have no chest pain" yields **no** risk flags (the denied
  mentions are reported as `negated_flags`), "I had not taken my meds today" yields
  `meds_taken: false`, and "I did take my pills though" yields `meds_taken: true`.
  `meds_taken` is tri-state (`true` / `false` / `null` = not mentioned) so the UI never
  asserts a wellness fact the senior did not state. An explicit `meds_taken: false`
  check-in always returns an amber "Today needs a little attention" daily card —
  never a green "Today looks good" — and adds a small, capped, non-escalating
  signal to the deterministic risk score (a status reflection, not a diagnosis).
- **A late reply resolves the missed-check-in card.** When a check-in is recorded for a
  date, that day's R1 "missed check-in" card is rewritten to say the reply was received
  (with the timestamp) instead of claiming KinKeeper is still awaiting one. This factual
  update applies whether the card is still open **or already acknowledged** — an
  acknowledged card keeps its acknowledged (seen) status, but its body and `source`
  are corrected so the family timeline never states something that is no longer true.
  Proactive prompts distinguish a *missed check-in* opener from a *risk follow-up* in
  both copy and the `kind` field.

## Dana's family action loop & card evidence

Escalation and missed-check-in cards are not dead ends: Dana can record a clear human
next step right on the card — **Plan a call**, **Tried to call**, **Reached Maggie**, or
**Follow up later** (`POST /api/inbox/:id/action`). The action loop is truthful by
construction:

- **It only records what Dana says she did or plans.** No phone call is placed, no
  message or notification is sent, nothing is concluded medically, and there is no
  emergency response. Every response carries a `truth_note` saying exactly that.
- **Mark as seen stays separate.** Acknowledgement is an inbox state
  (`POST /api/inbox/:id/ack`); action steps are a distinct record and do not change
  open/seen status. Like the action loop, ack requires the owning `senior_id`:
  a missing/unknown senior or a cross-senior ack is rejected with 400, an unknown
  card with 404, and no rejected call mutates anything. A duplicate ack replays
  the card's current state without a second seen record.
- **One record per (card, action).** A unique dedupe key makes a double submit return
  the original record (`deduplicated: true`) instead of a duplicate timeline entry.
  Once *Reached Maggie* is recorded the loop is complete and no further steps are
  offered.
- **Validation guards the target.** The claimed `senior_id` must exist and must own the
  card; unknown actions and non-actionable (informational) cards are rejected with 400,
  unknown cards with 404.
- **Real timestamps only.** Steps are stamped with the demo's virtual clock. Cards
  acknowledged before the `ack_ts` column existed show "seen" without an invented time.

Each card renders a **persistent, chronological timeline** — card created, Maggie's
reply if any, seen by family, and Dana's recorded steps — computed server-side from the
event store (`card_actions` table + `family_action_recorded` / `family_card_seen`
events, both created by safe additive migrations on existing SQLite files) so it
survives refresh and restart.

An expandable **"Why this card?"** panel explains each card in plain language: the exact
source quote when one exists, the observed timing/check-in/reply facts, and at most
relevant 7-day context from the actual journal (e.g. "She also mentioned 'fall' on Thu,
Oct 3."). The context window is **anchored at the card's creation time** — it describes
what was true when KinKeeper placed the card, so a later event (even another fall the
next day) never rewrites an old card's rationale; later facts appear on the card's
timeline instead. The panel never shows rule IDs, scores, or audit internals, and it
never re-interprets risk beyond what was observed.


## MCP tools (self-hosted, spec 2025-11-25, Streamable HTTP)

| Tool | Purpose | Key output |
|---|---|---|
| `record_checkin` | Store a check-in transcript; deterministically extract sleep / meds / activity / mood / risk phrases / watched topics | structured facts + daily status card |
| `get_care_journal` | Longitudinal history for cross-session recall | dated entries with excerpts |
| `assess_risk` | Transparent rule-based score over recent events in a rolling window | `score`, `level`, `escalate`, `reasons`, `escalate_semantics` |
| `notify_family` | Place an actionable card in the **local** family inbox | `delivered_externally: false` + card |
| `schedule_followup` | Queue a proactive re-engagement | due timestamp |
| `get_weekly_digest` | 7-day completion / mood / recurring topics / risk days | digest card payload |

**`assess_risk.escalate` is a rolling-window threshold, not a this-turn decision.** It
stays `true` for as long as an earlier adverse event keeps the window score at or above
the threshold — so a benign new utterance can still return `escalate: true`. It never by
itself creates a card or sends anything (nothing is ever sent externally; cards wait in
the local inbox). The per-turn action signal is the orchestrator's `escalated` field in
the `POST /api/chat` response: true when *that message itself* qualified for family
escalation and the inbox holds the corresponding card — newly created, or reused
idempotently when the exact same message is replayed (`notify_family` returns the
original card with `card.deduplicated: true`, so no second card appears). The additive
`card_created_this_turn` flag is true only when this turn actually minted the card. The
UI keys "a card is waiting in Family updates" off `escalated`, never off the assessment
score.

## Deterministic rules

| Rule | Trigger | Action |
|---|---|---|
| R1 `MISSED_CHECKIN` | No check-in by `checkin_time` + `grace_minutes` | proactive prompt + amber inbox card with suggested action |
| R3 `REPEATED_TOPIC` | Watched concern on ≥3 distinct days in 7 | info card for family + digest highlight |

Rules are pure functions (`src/rules.js`) — same inputs, same outputs, unit-tested.
The demo "fast-forward" button only moves the virtual clock (`src/clock.js`); it never
touches rule logic, and every clock advance is itself audit-logged.

## Honest engineering notes / limitations

- The companion's dialogue is a **deterministic template engine** (`src/orchestrator.js`
  + `src/extract.js`), deliberately **not** an LLM and **not** Amazon Bedrock: this build
  avoids paid APIs and credentials, keeps every turn reproducible, and claims no external
  integration it does not perform. The MCP boundary is where an LLM agent (or Alexa+
  itself) would attach.
- The Alexa+ experience is **simulated in the web app**, a path the track rules explicitly
  allow; no Alexa+ endpoint, account or trademark assets are used.
- English transcripts only; one synthetic persona; local-only by default (loopback bind;
  broad binds require an explicit bearer token — see above); voice input/output uses the
  browser's built-in Web Speech API when available, with text fallback.
- `notify_family` is intentionally a local inbox write. The audit trail records
  `delivered_externally: false` on every call.
- **What persists across a refresh/restart (and what does not).** The care journal,
  family inbox cards, follow-ups, audit trail and the virtual clock all live in the
  SQLite event store and survive page refreshes and server restarts — the Today view's
  status banner is rendered from that persisted state (`last_checkin` / `last_risk` in
  `GET /api/state`), so it can never contradict the journal after a refresh. The
  **chat bubbles are intentionally session-only**: they are a presentation of the
  current conversation, not a record — the durable record of every turn is the
  journal entry and the audit trail (journal and cards are visible in the Today and
  Family updates views after a refresh; the audit trail is available via
  `GET /api/audit`).

## Relationship to other submissions

KinKeeper is a **new, independent project** created during the hackathon window. It
shares no code, assets, or concept with the author's earlier, separate submission
"Show, Don't Tell": KinKeeper is a server-centric proactive care-coordination system
built around a self-hosted MCP server, deterministic rules and a persistent event store —
a different track concept, architecture and codebase.

## License

MIT — see [LICENSE](LICENSE).
