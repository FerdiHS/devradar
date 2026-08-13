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

Identity resolution may make at most one automatic retry for a transient
transport failure and at most one for a `5xx` response. A failed lookup never
creates or changes a followed-person association.

## Request contract

Every GitHub REST request uses:

```text
Accept: application/vnd.github+json
User-Agent: DevRadar/<plugin-version> (https://github.com/FerdiHS/devradar)
X-GitHub-Api-Version: 2026-03-10
```

The Events request uses `per_page=100`. The pinned API version is deliberate;
changing it is a compatibility change, not an incidental implementation edit.

The [GitHub Events REST documentation](https://docs.github.com/en/rest/activity/events?apiVersion=2026-03-10)
defines the public user-events endpoint, ETag polling, `X-Poll-Interval`,
pagination, a maximum recent timeline, and delayed event availability.

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

Before requesting a next link, validate that it:

- uses HTTPS;
- has host `api.github.com`;
- targets the public user-events endpoint;
- refers to the canonical followed username;
- contains only the documented `page` and `per_page` query parameters, with
  positive page numbers and `per_page` between 1 and 100;
- contains no fragment, credentials, or other query parameters;
- contains no unexpected origin, path, or identity.

An invalid next link is a safe retrieval failure. It must not mutate the note,
advance successful state, or cause DevRadar to follow an arbitrary external
origin.

All pages required for one person's attempt must succeed before that attempt
can commit note changes, new deduplication state, a successful ETag, or
`lastSuccessfulSyncAt`. A page-2 or page-3 failure leaves that person at its
previous last-known-good successful state.

## Conditional requests and polling

Persist the successful first-page representation's ETag and later send it as
`If-None-Match` while the cached representation remains valid. A valid `304 Not
Modified` is a successful unchanged result: no later pages are requested, no
note is written, and ordinary operational success metadata may advance.

An ETag observed during incomplete retrieval is not authoritative successful
representation state.

Honor `X-Poll-Interval` through the per-person `pollNotBefore` state. If a
manual sync starts before that boundary, make no Events request and return a
successful operational `skipped` outcome with the earliest permitted time
when available. Pagination for an already-started retrieval is part of that
same polling operation.

Invalidate reusable provider response-cache state for every followed person
when tracking-start or a future global activity-eligibility change could make
previously filtered activity eligible. A note-path change does not invalidate
the ETag because it does not change retrieval eligibility.

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
HTTP `403` or `429`, is provider-wide for the current Sync All run:

1. parse a valid non-negative `Retry-After` value as a delay in seconds and
   honor the resulting future boundary;
2. otherwise, when `x-ratelimit-remaining` is zero, honor a valid future
   `x-ratelimit-reset` value;
3. otherwise use at least one minute as the earliest next-attempt boundary.

Missing, malformed, or expired retry and reset headers use the one-minute
fallback; they never permit another request during the current Sync All run.

The manual MVP does not sleep until the boundary or retry later inside the same
operation. The current incomplete person fails, further GitHub requests stop,
and remaining people are `skipped`. Already completed people retain their
successful results.

If the final required page for a person succeeds while remaining quota becomes
zero, that person may commit successfully; later requests still stop.

At most one automatic retry is allowed for transient transport/network
failures and `5xx` responses. Do not retry ordinary `4xx`, `304`, primary rate
limits, or secondary rate limits. A failed permitted retry becomes a
person-scoped failure unless the response demonstrates a provider-wide request
contract problem.

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
prevent an invalid future request. Successful ETag, deduplication, and
`lastSuccessfulSyncAt` state may advance only after complete safe processing.

## Outcome compatibility

The provider adapter supplies the sync outcome model:

- `updated` — complete retrieval produced new eligible activity and the note
  was committed;
- `unchanged` — complete retrieval produced no note change, including `304`;
- `failed` — an attempted person could not complete safely;
- `skipped` — no person request was attempted because an approved polling,
  rate-limit, or provider-wide condition prohibited it.

`skipped` must never disguise a request that was actually attempted and failed.

## Deterministic implementation test matrix

Future tests use sanitized local fixtures and no live GitHub requests. Cover:

- request URL, headers, API version, and `per_page=100`;
- identity resolution success and failure;
- one-, two-, and three-page retrieval through `Link`;
- invalid pagination origins, paths, and identities;
- duplicate events across pages;
- old/known events not terminating pagination;
- `200` followed by `304`;
- ETag invalidation;
- poll-interval skip without a request;
- primary and secondary rate limits;
- quota exhaustion on a final successful page;
- page-2 and page-3 failures;
- `404` and malformed responses;
- unsupported API-version/provider-contract failure;
- one successful retry and repeated transient/`5xx` failures;
- no retry for normal `4xx`, `304`, or rate limits;
- provider-wide stopping and remaining-person skipping;
- preservation of prior ETag, deduplication, and successful state after
  incomplete retrieval;
- preservation of provider-policy boundaries after failed retrieval.
