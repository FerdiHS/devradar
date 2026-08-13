# DevRadar synchronization specification

This document resolves synchronization state, deduplication, idempotency, and
failure behavior for
[Issue #63](https://github.com/FerdiHS/devradar/issues/63). It defines
behavior only; it does not implement Sync One, Sync All, GitHub retrieval, or
note mutation.

## State ownership and shape

Synchronization and provider metadata are plugin-owned internal state inside
an active followed-person record. It is not a second user-editable settings
file and is never rendered as hidden Markdown metadata.

The canonical state shape is:

```ts
type PersonSyncState = {
	lastAttemptAt?: string;
	lastSuccessfulSyncAt?: string;
	seenEvents: Array<{
		id: string;
		createdAt: string;
	}>;
	github: {
		etag?: string;
		pollNotBefore?: string;
	};
};
```

All persisted timestamps use canonical UTC ISO-8601 strings. A new association
starts with `seenEvents: []` and an empty `github` object.

`lastAttemptAt` is operational metadata and need not become durable when a
state save fails. `lastSuccessfulSyncAt` records the latest per-person sync
whose intended effects completed safely. It is never an activity identity,
deduplication cursor, or proof of complete history. ETag and polling state are
provider optimizations, not activity identity.

## Primary identity and canonical reconciliation

The GitHub Events API event ID is the primary identity for supported activity.
Do not use rendered Markdown, timestamps, repository/type composites, semantic
similarity, AI, or fuzzy matching as the primary identity.

An event becomes `seenEvents` only after either:

1. its canonical activity is successfully written to the managed section; or
2. canonical reconciliation establishes that the same canonical activity is
   already present.

Retrieval alone does not make an event seen. Events filtered by tracking start,
future activity eligibility, or a valid unsupported event/action remain
unrecorded. A supported mapping with invalid required data fails the person's
sync under [`github.md`](github.md) and does not advance successful state.

For an eligible event absent from `seenEvents`:

1. normalize it using [`activity.md`](activity.md);
2. construct its canonical activity representation;
3. inspect the valid managed section from [`person-note.md`](person-note.md);
4. if the exact canonical entry exists, do not append it and record its event ID
   only after state persistence succeeds;
5. otherwise include it as new activity.

This supports re-follow and state-save recovery without adding provider IDs to
Markdown. If a user deletes or rewrites an already-seen entry while the follow
remains active, the event remains seen and is not automatically restored.

The active follow retains enough seen IDs to prevent duplication for activity
that GitHub can still return. Event IDs may be pruned once they are safely
beyond the provider's documented retrievable horizon, so pruning must never
make an event that GitHub can still return appear unseen. The exact pruning
algorithm and schedule are implementation details; retaining IDs for the
active follow is a valid implementation until safe pruning is available.
Unfollowing removes that active state and creates no inactive-person tombstone.

## Per-person sync boundary

A permitted per-person sync follows this logical order:

```text
validate settings
→ acquire global sync ownership
→ honor pollNotBefore
→ retrieve all required provider pages
→ normalize supported activity
→ apply tracking-start and activity eligibility
→ deduplicate and reconcile canonical entries
→ validate the associated note and managed range
→ compute final Markdown
→ write only changed Markdown
→ persist newly seen IDs and successful provider state
→ record successful completion
→ release global sync ownership
```

The implementation may organize modules differently, but it must preserve the
following invariants:

- Required retrieval completes before note mutation or successful state
  advancement.
- A required later-page failure leaves the note, seen IDs, ETag, and
  `lastSuccessfulSyncAt` at their previous last-known-good values.
- New events are marked seen only after note accounting.
- A note write is never destructively rolled back when a later state save
  fails.
- A later sync recovers after that state-save failure through canonical
  reconciliation.
- Identical resulting Markdown causes no vault write.

Provider-policy metadata such as a newly observed poll boundary or retry
boundary may be persisted after a failed attempt when necessary to prevent an
invalid future request. It must not be confused with successful representation
state.

## Successful and failed outcomes

The per-person outcome is one of:

- `updated`: complete successful retrieval changed the note;
- `unchanged`: complete successful retrieval caused no note change, including a
  valid `304 Not Modified`;
- `failed`: an attempted operation could not complete safely;
- `skipped`: no request was attempted because an approved provider policy or
  provider-wide block prohibited it.

Successful completion may advance `lastSuccessfulSyncAt`, newly accounted
event IDs, and valid provider cache state. A failed attempt retains the previous
successful state except for safely observed attempt or provider-policy data.

## Configuration transitions

Changing a tracking start preserves notes, `seenEvents`, and successful-sync
metadata, while invalidating provider response-cache state so still-visible
events can be reconsidered. This applies in both directions.

Changing a future global activity eligibility configuration invalidates the
reusable provider response-cache state for every followed person while
preserving notes, `seenEvents`, and successful-sync metadata. Schema v1 has no
such user-facing activity configuration.

Changing a note path preserves all sync, deduplication, successful-sync, and
provider-cache continuity and does not migrate or rewrite the old note. Only
future unseen activity is written to the new destination.

## Overlap and Sync All

Use one process-local global synchronization ownership boundary. While Sync
One or Sync All is running, another manual synchronization cannot start.

Sync All processes people sequentially. Each person is an independent commit
boundary:

- one person's failure does not roll back another person's successful update;
- ordinary person-scoped failures do not prevent later people from being
  attempted;
- provider-wide blocks stop further requests;
- unattempted people are `skipped`, not `failed`;
- aggregate results preserve `updated`, `unchanged`, `failed`, and `skipped`.

The `v0.2.0` implementation slice ships Sync One only. This Sync All contract
is documented for later implementation compatibility and does not add a
Sync-All command to the release slice.

## Retry and provider boundary

Correctness does not depend on retries. Retry timing, rate-limit classification,
and provider-wide stopping are owned by [`github.md`](github.md). This
specification owns the consequences for note and sync state:

- incomplete retrieval cannot commit activity or successful state;
- a person-scoped provider failure preserves that person's last-known-good
  state;
- a provider-wide stop preserves completed people and skips remaining people;
- a later manual sync can recover from a failed attempt.

## Deterministic implementation test matrix

Future implementation tests use sanitized local fixtures, never live GitHub
requests, and must cover:

### Deduplication and reconciliation

- repeated IDs in one response and across pages;
- distinct events with similar rendered facts;
- eligible versus filtered events entering `seenEvents`;
- an unseen event whose canonical entry already exists;
- reconstruction after missing state;
- re-follow with retained canonical history;
- rewritten or deleted entries while the person remains followed;
- retention of seen IDs for the active follow;
- pruning only IDs safely beyond the provider retrieval horizon without
  reintroducing duplicates.

### Commit and failure ordering

- note-write failure does not advance successful state;
- state-save failure after note success;
- recovery on the next sync;
- required later-page failure leaves note and successful state unchanged;
- previous successful state survives a later failed attempt;
- provider-policy boundaries may survive where required.

### Configuration and idempotency

- tracking-start changes in both directions;
- provider-cache invalidation after eligibility changes;
- note-path change preserving continuity without old-note migration;
- repeated successful sync with no provider change;
- valid cache-hit behavior;
- identical Markdown causing no vault write.

### Concurrency and partial failure

- Sync One and Sync All cannot overlap;
- two Sync All operations cannot overlap;
- Sync All is sequential;
- one failure preserves other successful people;
- later people continue when provider policy permits;
- aggregate outcomes distinguish all four outcome categories.

## Out of scope

This specification does not implement or redefine:

- the GitHub HTTP/API adapter;
- the event-to-activity mapping owned by [`activity.md`](activity.md);
- activity Markdown formatting or managed markers owned by
  [`person-note.md`](person-note.md);
- detailed GitHub error messages, rate-limit UX, retry delays, or algorithms;
- startup, scheduled, or real-time synchronization;
- webhooks, authentication, private activity, repository tracking, or
  organization tracking;
- concurrent GitHub requests, persistent lock files, distributed locks, or
  cross-device coordination;
- hidden event IDs in notes, fuzzy identity reconstruction, inactive-person
  tombstones, or automatic historical-note migration;
- automatic pruning of user-authored note content;
- AI summaries, importance judgments, scoring, ranking, or behavioral analysis.
