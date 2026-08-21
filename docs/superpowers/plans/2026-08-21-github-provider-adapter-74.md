# GitHub provider adapter — Issue #74

## Delivery boundary

Implement one coherent unauthenticated GitHub provider-adapter capability. The
adapter owns documented REST requests through Obsidian `requestUrl()`, raw
response validation, pagination, policy/status interpretation, and mapping to
the canonical activity domain from #71. It does not own Follow, Sync One/All,
settings persistence, note mutation, or application outcomes.

Do not introduce concrete application port names or shapes. Preserve the four
conceptual outcomes: success, no-request/provider-policy block,
person-scoped failure, and provider-wide failure. Only canonical identity or
activities, safe diagnostics/category, policy boundaries, and request-attempted
state may cross the adapter boundary. Raw payloads stay inside the adapter.

## Implementation

1. Add only the smallest adapter-local modules and injected transport seam
   needed for deterministic tests. Production uses only `requestUrl()` and the
   two approved GET endpoints, exact headers, supplied plugin version,
   `per_page=100`, no authentication, ETags, `/rate_limit`, generic HTTP or
   retry frameworks, or new dependencies.
2. Keep redirect behavior and supported response representation fail-closed by
   default. Treat the bounded redirect/origin verification as a post-merge
   production-enablement check; if `requestUrl()` cannot preserve approved
   origin, identity/rename, and pagination guarantees, keep the transport
   disabled and document the blocker. Do not use fetch, Node, Electron-only, or
   private APIs.
3. Keep `isDesktopOnly: false`. Before production enablement, verify every used
   Obsidian API against the declared minimum Desktop/Mobile compatibility
   boundary, not only TypeScript declarations. Do not silently enable an
   unavailable minimum-version API; raise the minimum through a separate
   release-compatibility change when required.
4. Validate provider-policy boundaries before requests: global boundary for
   identity, global plus per-person polling boundary for Events, and zero
   requests when blocked.
5. Validate identity usernames, canonical logins, `User` account type, and
   positive IDs. Numeric IDs require exactly `Number.isSafeInteger(id) && id > 0`;
   preserved decimal strings are validated without unsafe numeric conversion.
6. Retrieve Events completely through validated `Link rel="next"` targets.
   Validate page/list and minimal event-entry structure; ignore unknown or
   deferred events only after that validation; fail malformed supported events.
   Map only Push, Pull Request, and Issue events through #71. Push requires
   `ref` and may use `head`; `before` is not an adapter requirement. Supported
   PR actions are opened, reopened, closed with `merged === false`, and merged
   through closed/merged with `merged === true`; supported Issue actions are
   opened, reopened, and closed.
7. Enforce HTTPS `api.github.com`, canonical user/path/query identity, exactly
   one next page, `per_page=100`, no credentials/fragments/extras, and no loops,
   skips, duplicates, or drift. Request at most pages 1–3; a page-3 next link
   requiring page 4 is provider-wide incompatibility.
8. Require complete retrieval before success or state advancement. Deduplicate
   equal canonical event IDs and fail conflicting duplicates. Allow one retry
   total per logical identity operation and per complete Events operation only
   for transient transport or 5xx failures. Never retry 4xx, 304, malformed
   data/pagination, rate limits, or pinned-version incompatibility.
9. Parse `X-Poll-Interval` on every successful Events page as a non-negative
   integer, using response-observation time and the maximum/latest boundary
   across pages. Missing or malformed values fail closed; do not apply a new
   boundary between pages of the same retrieval.
10. Classify primary limits only for relevant 403/429 responses with valid
    remaining zero. When primary exhaustion is not established, secondary
    evidence is limited to an explicit parsed GitHub secondary-limit message or
    valid non-negative `Retry-After`. Parse `Retry-After` as seconds and reset
    as epoch seconds; preserve the latest/max boundary, one-hour primary and
    one-minute secondary fallbacks, and conservative provider-wide stopping.
    Observe remaining-zero successful responses as global boundaries without
    relabeling their status; a final page may complete, but a non-final page
    cannot return partial success.
11. Treat only documented unsupported/retired pinned-version evidence as
    provider-wide (explicit unsupported-version 400 or retired-version 410).
    Treat 304 as failure, never unchanged success.
12. Update the appropriate authoritative checked-in contracts, especially
    `docs/github.md`, with these approved clarifications before or alongside
    the implementation PR. Do not broaden any existing non-goal.

## Tests and verification

Use sanitized fixtures and injected fake transport; never make live GitHub
requests. Cover request construction, zero-request policy blocks, identity and
actor binding, decimal IDs, all supported mappings/actions, malformed supported
events, unknown/deferred events, page/list/event-entry validation, pagination
trust boundaries, the three-page ceiling, complete retrieval/no partial
success, duplicate conflicts, retry budgets, polling timing, primary/secondary
and ordinary-403 policy, successful quota-zero responses, 304, pinned-version
failures, result scope/request-attempted state, raw-payload containment, and
the fail-closed post-merge production-enablement boundaries. Do not claim that
redirect feasibility or minimum-runtime compatibility has been verified by the
implementation issue's automated tests.

Run `npm run test`, `npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm run build`, and `npm run check`.

## Acceptance matrix

| ID  | Criterion                                        | Authority                 | Evidence                                                                 | Status                          |
| --- | ------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------ | ------------------------------- |
| A1  | REST through `requestUrl()` only                 | #74, github, architecture | Adapter + request tests                                                  | Verified                        |
| A2  | Minimal injected seam; no framework/dependency   | #74                       | Diff/dependency review                                                   | Verified                        |
| A3  | Exact headers and supplied version               | #74, github               | Header assertions                                                        | Verified                        |
| A4  | `per_page=100`, no auth/ETag/preflight           | #74, github               | Negative request tests                                                   | Verified                        |
| A5  | Safe `User` identity validation                  | #74, settings             | Identity tests                                                           | Verified                        |
| A6  | Actor ID/login binding                           | #74, github               | Mismatch tests                                                           | Verified                        |
| A7  | Canonical #71 Push/PR/Issue mapping              | #74, activity, #71        | Factory/output tests                                                     | Verified                        |
| A8  | Unknown/deferred safe; malformed supported fails | #74, activity             | Structural tests                                                         | Verified                        |
| A9  | Validated pagination origin/path/identity        | #74, github               | Link matrix                                                              | Verified                        |
| A10 | Three-page ceiling and page-4 failure            | #74, github               | Ceiling tests                                                            | Verified                        |
| A11 | Complete retrieval before success/state          | #74, sync                 | Later-page tests                                                         | Verified                        |
| A12 | Deterministic duplicate handling                 | #74, sync                 | Duplicate tests                                                          | Verified                        |
| A13 | Policy blocks make zero requests                 | #74, settings             | Request-count tests                                                      | Verified                        |
| A14 | Poll/rate boundaries use observation/max timing  | #74, github               | Boundary tests                                                           | Verified                        |
| A15 | Deterministic rate-limit evidence/fallbacks      | #74, github               | Header/message matrix                                                    | Verified                        |
| A16 | Quota-zero final/non-final behavior              | #74, github               | Successful-response tests                                                | Verified                        |
| A17 | 304 fails                                        | #74, github               | Regression test                                                          | Verified                        |
| A18 | One retry total per logical operation            | #74, github               | Retry tests                                                              | Verified                        |
| A19 | Narrow pinned-version incompatibility            | #74, github               | 400/410 tests                                                            | Verified                        |
| A20 | Four outcomes/minimum safe data                  | #74, architecture         | Result tests                                                             | Verified                        |
| A21 | Raw payload containment                          | #74, architecture         | Boundary inspection                                                      | Verified                        |
| A22 | Redirect/origin production enablement            | #74, architecture         | Post-merge manual verification; transport remains fail-closed by default | Deferred: post-merge enablement |
| A23 | Desktop/Mobile/minimum compatibility             | #74, architecture         | Post-merge minimum-runtime verification before production enablement     | Deferred: post-merge enablement |
| A24 | No live requests in tests                        | #74, AGENTS.md            | Test review                                                              | Verified                        |
| A25 | Clarifications added to contracts                | #74, github               | Docs diff/reread                                                         | Verified                        |
| A26 | `npm run check` passes                           | #74, AGENTS.md            | Command output                                                           | Verified                        |

## Sequencing

#71 is the required predecessor. #70 remains independent note-mutation
feasibility work; #72 is downstream; #73 is not a hard prerequisite for this
adapter. These tracks converge later for end-to-end Sync One.

## Post-merge production-enablement evidence

- `manifest.json` declares `minAppVersion: 1.0.0` and `isDesktopOnly: false`.
- The official `obsidian-api` contract at commit
  `402f57cb26c6987f437ac0ea0b69979e1c77bc7d` (2022-08-13) includes
  `requestUrl()`, `throw: false`, and the status/header/body response shape.
  That predates the official Desktop 1.0.0 release (2022-10-13) and Mobile
  1.4.0 release (2022-10-19), but it is API-contract evidence rather than
  minimum-runtime execution evidence.
- The installed desktop bundle currently routes its request bridge with
  automatic redirect following and returns status, headers, and body without
  exposing the final URL/origin. The transport therefore remains fail-closed
  by default. After the implementation merges, manually verify whether a
  supported behavior preserves the approved redirect/origin, followed-person
  identity, rename, and pagination guarantees before production enablement.
