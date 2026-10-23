# KinKeeper developer friction log

These entries describe issues encountered while building the local synthetic care-coordination prototype for the Amazon Developer Hackathon. Severity reflects their effect on this project.

## 1. Reaching the Alexa+ development surface

- **Task:** Get from zero to a testable Alexa+ experience.
- **Steps:** Looked for the official Alexa+ developer tools and simulator, then checked the event's access guidance.
- **Expected:** Participant access to the tooling, or an application path for testing against the real surface.
- **Actual:** The [official hackathon FAQ](https://amazonappdev2026.devpost.com/details/faqs) states that the gated Alexa+ tools and simulator are limited to select partners and are unavailable to hackathon participants. It permits demonstrating a self-hosted MCP server through a custom simulator or front end.
- **Severity:** High for the original testing plan: the project could not be validated against the actual Alexa+ surface.
- **Workaround:** Built a real self-hosted MCP server using specification 2025-11-25 and Streamable HTTP, with a web-simulated experience. The demo identifies its fictional characters and local scope; family cards do not deliver external notifications.
- **Suggestion:** Provide a participant sandbox or a publicly testable packaging and validation path, so developers can check how their MCP capabilities behave on the intended surface.

## 2. Node runtime mismatch during the initial review

- **Task:** Run the project's then-current 36-test suite during an early local review.
- **Steps:** Invoked npm with a Node 22 npm CLI while the child `node --test` process still resolved to the machine's default Node 25.
- **Expected:** The test child would use Node 22 and load the existing native SQLite module.
- **Actual:** `better-sqlite3` could not load: its binary was built for Node 22, but Node 25 expected a different native-module ABI. The error reported `ERR_DLOPEN_FAILED` and `NODE_MODULE_VERSION` 141 versus 127, so the suite could not start.
- **Severity:** Medium: fully blocked that test attempt and was confusing because npm itself was running under Node 22.
- **Workaround:** Put Node 22 first on PATH so child processes inherited it. The historical suite then passed 36/36 without rebuilding the module. The README also documents `npm rebuild better-sqlite3` as an alternative when changing Node versions.
- **Suggestion:** Explain the running and expected Node versions alongside native-module load failures, with the matching rebuild command.

The 36-test count belongs to this historical initial-review incident. Separately, the current source received an independent local acceptance on October 23, 2026 with **73 Node tests passing** and additional local HTTP/MCP checks. No test was rerun to prepare this document.

## 3. Designing application-specific retry safety

- **Task:** Retry a Streamable HTTP tool call safely after a lost or uncertain response.
- **Steps:** Mapped the protocol's request and session behavior onto the project's persistent writes, and looked through the MCP and SDK guidance consulted during this implementation for an application-level idempotency example.
- **Expected:** A directly reusable example covering a write that succeeds before its response is lost.
- **Actual:** We did not find a directly applicable example in the guidance we consulted. KinKeeper needed to decide how its own check-ins, family cards, follow-ups and audit events behave when a call is repeated.
- **Severity:** Medium: a blind retry could create duplicate care records or duplicate audit events.
- **Workaround:** Added stable `idempotency_key` support to `record_checkin` and `dedupe_key` support to `notify_family` and `schedule_followup`. Replays return the original stored result. The client automatically retries only a side-effect-free or keyed call; audit-producing reads are not blindly retried.
- **Suggestion:** Add an end-to-end SDK example showing a keyed mutation, a lost response, retry after reconnection, and the original result returned without a duplicate write.
