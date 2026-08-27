# DevRadar GitHub retrieval specification

This document resolves the GitHub retrieval, pagination, rate-limit, and
failure contract for
[Issue #64](https://github.com/FerdiHS/devradar/issues/64). It defines provider
behavior only; it does not implement the GitHub adapter or synchronization
pipeline.

## MVP API boundary

The unauthenticated MVP reads public data only through documented GitHub REST
APIs using Obsidian's `requestUrl()` API. It does not use authentication,
GraphQL, Octokit, scraping, undocumented endpoints, webhooks, or background
collection.

Use these endpoints:

- `GET /users/{username}` during follow and re-follow to resolve the canonical
  GitHub `login` before persisting an association;
- `GET /users/{username}/events/public` for per-sync public activity retrieval.

Ordinary note-path/tracking-start edits and per-sync retrieval do not perform a
separate profile preflight. The Events request itself determines whether
activity is currently retrievable.

The identity response must provide the canonical `login`, positive numeric
`id`, and `type === "User"` before an association is persisted. The numeric ID
is stored as the followed person's `githubAccountId`. Organization, bot, and
all other account types are rejected as unsupported in the people-first MVP;
they require a later product contract. During event normalization, require
`event.actor.id` to equal the stored ID and require `event.actor.login` to
equal the stored canonical username case-insensitively. An ID mismatch or a
matching ID with a changed login is a person-scoped failure; never infer or
silently apply a GitHub rename.

Validate a draft username before constructing `/users/{username}`. The
returned canonical `login` must satisfy the username grammar in
[`activity.md`](activity.md) before it is persisted or used in request paths,
profile links, or managed-note markers; do not interpolate an unvalidated
provider value.

Provider identity IDs and event actor IDs must be positive integer JSON values.
Convert each to the same canonical positive-decimal string representation by
serializing base-10 digits without leading zeroes before persistence or
comparison. Fractional, negative, non-integer, or otherwise malformed IDs are
invalid required identity data. When represented as JavaScript numbers, the
parsed value must also satisfy `Number.isSafeInteger(id) && id > 0`; otherwise
the provider data fails closed. Implementations that preserve the raw decimal
token may apply the same positive-integer validation without converting through
an unsafe number.

Identity resolution may make at most one automatic retry total, and only when
the first failure is a transient transport/network failure or a `5xx` response.
A failed lookup never creates or changes a followed-person association.

## Request contract

Every GitHub REST request uses:

```text
Accept: application/vnd.github+json
User-Agent: DevRadar/<plugin-version> (https://github.com/FerdiHS/devradar)
X-GitHub-Api-Version: 2026-03-10
```

The Events request uses `per_page=100`. GitHub's documented public Events
timeline exposes at most 300 recent events, so one complete retrieval requests
at most three pages. A `rel="next"` target from page 3 that requires page 4 is
a provider-contract incompatibility and must fail closed rather than being
followed indefinitely. The pinned API version is deliberate; changing it is a
compatibility change, not an incidental implementation edit.

The [GitHub Events REST documentation](https://docs.github.com/en/rest/activity/events?apiVersion=2026-03-10)
defines the public user-events endpoint, `X-Poll-Interval`,
pagination, a maximum recent timeline, and delayed event availability.

## Redirect scope and accepted residual risk

The MVP intentionally uses only these GitHub REST operations:

- `GET /users/{username}` for public identity resolution;
- `GET /users/{username}/events/public` for public activity retrieval; and
- validated `rel="next"` links for subsequent Events pages.

The production boundary rejects requests outside this URL and public-header
scope before calling `requestUrl()`; the adapter remains responsible for
canonical identity and pagination validation.

GitHub's current [user](https://docs.github.com/en/rest/users/users?apiVersion=2026-03-10)
and [public-user-events](https://docs.github.com/en/rest/activity/events?apiVersion=2026-03-10)
reference pages document no `3xx` response for these operations. DevRadar does
not use the explicitly redirect-capable [archive](https://docs.github.com/en/rest/repos/contents?apiVersion=2026-03-10),
[release-asset](https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28),
or binary repository-content operations. This endpoint scope reduces the
practical redirect risk, but it does not guarantee that GitHub will never
redirect a request; [GitHub's general REST guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
says clients should assume that any request may redirect.

Obsidian's supported `requestUrl()` response does not expose the final URL or
origin. The current Desktop probe therefore cannot establish a final-target
security invariant. For the current unauthenticated, public-data endpoint
scope, DevRadar accepts this as a documented residual transport risk and does
not claim that redirects are impossible. If a future change adds a new
endpoint, follows a new provider URL, or sends credentials, reassess this
decision before implementation.

## Available history

GitHub Events are a recent, bounded provider feed rather than exhaustive
history. The documented feed currently exposes at most 300 events from roughly
the previous 30 days, and event delivery may be delayed.

Therefore:

- `from-now` starts prospective tracking but still relies on the feed becoming
  available;
- `available-recent` means whatever history GitHub currently exposes;
- an older selected start remains valid configuration;
- DevRadar attempts only history GitHub still exposes;
- DevRadar never claims unavailable history was recovered or that a returned
  window is complete merely because it is shorter than 30 days;
- a high-activity user may hit the event-count limit first.

These are provider limitations, not DevRadar guarantees.

## Pagination and trust boundary

For a normal `200 OK`, follow the provider's `Link` header until there is no
`rel="next"` relation. Do not construct later pages from assumptions and do
not stop because an event is old, known, ineligible, or produces no new
activity.

Track the effective page number for the request being processed; the initial
Events request is page 1. Before requesting a next link, validate that it:

- uses HTTPS;
- has host `api.github.com`;
- targets the public user-events endpoint;
- refers to the canonical followed username;
- is the only `rel="next"` target in the response;
- contains exactly one `page` query parameter whose positive value is the
  current page number plus one;
- contains exactly one `per_page` query parameter whose value is exactly `100`;
- contains no fragment, credentials, or other query parameters;
- contains no unexpected origin, path, or identity.

Repeated, backward, or skipping page targets, duplicate `rel="next"`
relations, duplicate query parameters, parameter drift, and any other invalid
next link are safe retrieval failures. They must not mutate the note, advance
successful state, or cause DevRadar to follow an arbitrary external origin.

Each page must be a JSON array. Each entry must be a non-null object with a
non-empty string `type` before it can be classified. Unknown event types and
documented deferred event families are ignored after that minimum check; their
irrelevant payload fields are not validated. `PushEvent`, `PullRequestEvent`,
and `IssuesEvent` require the common `id`, `created_at`, `repo.name`, and
`actor.id`/`actor.login` envelope plus their mapping-specific fields. A
malformed supported event is provider data failure for that person, not an
unsupported event. The v0.2.0 Push mapping consumes `payload.ref` and may use
`payload.head`; `payload.before` is optional semantic metadata but is not an
adapter requirement.

The page ceiling is separate from the one-retry-total budget for one logical
Events operation. A valid next link from page 3 that would request page 4 is a
provider-wide incompatibility because equivalent remaining requests cannot be
trusted under the approved public-feed contract.

All pages required for one person's attempt must succeed before that attempt
can commit note changes, new deduplication state, or `lastSuccessfulSyncAt`.
A page-2 or page-3 failure leaves that person at its previous last-known-good
successful state.

## Conditional requests and polling

The `v0.2.0` Events retrieval never sends `If-None-Match` and does not use
ETag-based conditional requests. Each permitted Sync One begins with an
unconditional first-page request and follows the validated `Link` chain from
each response. A `304 Not Modified` response is not an accepted Events result
in v0.2.0 and must fail closed for that person.

Honor `X-Poll-Interval` through the per-person `pollNotBefore` state. On every
successful Events page, parse the supported header as a non-negative integer
number of seconds and compute the boundary from the response-observation time.
Missing or malformed required values fail closed. Preserve the latest/maximum
valid boundary across pages and report it with success or an applicable later
failure. A newly observed boundary never blocks page 2 or page 3 of the same
already-started retrieval. If a manual sync starts before that boundary, make
no Events request and return a successful operational `skipped` outcome with
the earliest permitted time when available.

## Rate-limit observation

Do not call `/rate_limit` before every sync. Use headers from the Events and
identity requests, including:

- `x-ratelimit-limit`;
- `x-ratelimit-remaining`;
- `x-ratelimit-reset`;
- `retry-after`;
- other documented signals needed to classify the response.

The [GitHub REST rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
states that unauthenticated quota is associated with the originating IP, not
exclusively with DevRadar. Any displayed remaining quota must not be described
as DevRadar-owned quota.

## Rate-limit and retry behavior

A recognized primary or secondary rate-limit response, normally returned as
HTTP `403` or `429`, is provider-wide for the current Sync All run. Classify
the response before choosing a future boundary:

1. For any recognized rate limit, parse a valid non-negative `Retry-After`
   value as a delay in seconds and honor the resulting future boundary.
2. For a `403` or `429` with a valid `x-ratelimit-remaining` value of zero,
   treat the response as a primary limit.
   Honor a valid future `x-ratelimit-reset` value. If that reset value is
   missing, malformed, or expired, persist a conservative boundary at least
   one hour after the rate-limited response. Stop the current run, do not
   schedule an automatic retry, and do not substitute a one-minute permission.
3. When primary exhaustion is not established, identify a secondary limit only
   for a `403` or `429` whose parsed GitHub error message explicitly indicates
   a secondary rate limit or whose supported response representation contains
   a valid non-negative `Retry-After`. A status code alone, remaining quota
   alone, arbitrary error text, or missing primary headers is insufficient.
   When the response is identified as a secondary limit and no valid
   `Retry-After` is available, use at least one minute as the earliest
   next-attempt boundary.

Ordinary or ambiguous `403`/`429` responses are not secondary limits. If the
response does not establish secondary limiting, use the conservative
primary-boundary behavior. Missing, malformed, or expired headers must never
authorize another request during the current Sync All run.

For any identity or Events response, a valid `x-ratelimit-remaining` value of
zero records a global future-request boundary from the applicable valid reset
or retry timing, even when the response is otherwise successful. A successful
final Events page may complete while returning that boundary. If another page
is required, stop before requesting it and fail without returning partial
activity success.

The manual MVP does not sleep until the boundary or retry later inside the same
operation. The current incomplete person fails, further GitHub requests stop,
and remaining people are `skipped`. Already completed people retain their
successful results.

If the final required page for a person succeeds while remaining quota becomes
zero, that person may commit successfully; later requests still stop.

At most one automatic retry total is allowed for transient
transport/network failures and `5xx` responses for each identity operation and
for each complete logical Events operation, including all of its pages. Do not
retry ordinary `4xx`, primary rate limits, secondary rate limits, malformed
provider data, invalid pagination, `304`, or pinned API-version failures. A
failed permitted retry becomes a person-scoped failure unless the response
demonstrates a provider-wide request contract problem.

## Pinned API version and transport compatibility

Treat a pinned API-version incompatibility as provider-wide only with
documented evidence that equivalent remaining requests are incompatible. This
includes a `400` or `410` response whose supported response data explicitly says
the requested API version is unsupported or retired. A generic `400` or `410`,
or a broad provider-error heuristic, is not sufficient.

See the [redirect-scope decision above](#redirect-scope-and-accepted-residual-risk);
reassess it if the endpoint scope or data sensitivity changes.

Production remains `isDesktopOnly: false`. Verify every Obsidian API used by
the adapter, including `requestUrl()`, against the declared minimum through
the required Desktop evidence or authoritative supported-API/version evidence.
Review Mobile compatibility through supported cross-platform APIs and the
absence of prohibited desktop-only dependencies; this review is not iOS or
Android runtime validation and is not a prerequisite for Desktop eligibility.
Mobile GitHub transport remains fail-closed until its applicable runtime
contract is separately validated or otherwise authorized by an approved
downstream contract. Current TypeScript declarations alone are not
compatibility evidence. If a required API is unavailable, raise the minimum
deliberately through the appropriate release-compatibility change rather than
silently weakening the contract.

The [GitHub Issue #83](https://github.com/FerdiHS/devradar/issues/83) body and
decision comment record the same accepted residual-risk disposition. This
repository change does not close the issue, establish final-origin observability,
waive minimum-runtime or platform compatibility review, or authorize broader
GitHub transport.

## Failure classification

Person-scoped failures include:

- unavailable account/activity;
- `404 Not Found`;
- malformed or unusable provider data affecting one person's retrieval;
- a transient request failure still failing after its permitted retry;
- a supported activity mapping whose required normalization data is invalid.

These failures preserve the followed-person configuration, existing note,
previous successful state, and already-confirmed deduplication IDs. A `404` is
not proof that the username was deleted or renamed, and DevRadar never infers
username changes.

Provider-wide failures stop equivalent requests for the current Sync All run.
Examples are recognized rate limits, an unsupported pinned API version, or a
request-policy incompatibility that would affect every remaining person. The
current person fails; people not yet attempted are skipped rather than failed.

Malformed data is normally person-scoped. If it demonstrates a provider-wide
contract incompatibility, it uses the provider-wide classification instead.

Provider-policy boundaries such as `X-Poll-Interval`, `Retry-After`, and reset
times may be persisted after an otherwise failed retrieval when needed to
prevent an invalid future request. Rate-limit boundaries are persisted in the
global `githubRequestPolicy` settings state and apply to every GitHub request,
including identity resolution and later Sync One operations. Per-person
`X-Poll-Interval` state remains in `PersonSyncState`. Deduplication and
`lastSuccessfulSyncAt` state may advance only after complete safe processing.

## Outcome compatibility

GitHub retrieval reports provider data, retrieval status, and provider-policy
information to the application sync use case. The application sync use case,
not the provider adapter, owns the final outcome after note and sync-state
processing:

- `updated` — complete retrieval and application processing changed the
  managed note;
- `unchanged` — complete retrieval produced no note change;
- `failed` — an attempted person could not complete safely;
- `skipped` — no person request was attempted because an approved polling,
  rate-limit, or provider-wide condition prohibited it.

`skipped` must never disguise a request that was actually attempted and failed.

## Deterministic implementation test matrix

Future tests use sanitized local fixtures and no live GitHub requests. Cover:

- request URL, headers, API version, and `per_page=100`;
- identity resolution success and failure;
- unsafe/non-safe integer IDs failing closed;
- durable account-ID binding and event actor-ID/login mismatch;
- organization, bot, and other unsupported identity types;
- one-, two-, and three-page retrieval through `Link`;
- invalid pagination origins, paths, and identities;
- self-loop, backward, and skipped-page `Link` targets fail closed;
- duplicate `rel="next"` relations and duplicate query parameters fail closed;
- `per_page` drift from 100 fails closed;
- duplicate events across pages;
- identical duplicate event IDs collapse, while conflicting activity under one
  event ID fails the person's sync;
- old/known events not terminating pagination;
- v0.2 Events requests never send `If-None-Match`;
- unexpected `304 Not Modified` fails the person without note mutation or
  successful-state advancement;
- poll-interval skip without a request;
- primary and secondary rate limits;
- primary limits with missing, malformed, or expired reset headers use the
  persisted conservative one-hour boundary rather than the secondary one-minute
  fallback;
- secondary limits without `Retry-After` use the one-minute fallback;
- a boundary observed by one operation blocks all later GitHub requests until
  it is reached, including identity lookup and a different Sync One;
- quota exhaustion on a final successful page;
- page-2 and page-3 failures;
- `404` and malformed responses;
- unsupported API-version/provider-contract failure;
- one successful retry and repeated transient/`5xx` failures;
- no retry for normal `4xx` or rate limits;
- provider-wide stopping and remaining-person skipping;
- preservation of prior deduplication and successful state after
  incomplete retrieval;
- preservation of provider-policy boundaries after failed retrieval.
