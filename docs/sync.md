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
		pollNotBefore?: string;
	};
};
```

Plugin-owned persisted timestamps use the exact canonical UTC millisecond form
defined by [`settings.md`](settings.md). A new association starts with
`seenEvents: []` and an empty `github` object.

Each `seenEvents.id` is the canonical provider event ID defined by
[`activity.md`](activity.md), not an unvalidated raw payload value. Its
`createdAt` is the canonical provider activity timestamp produced by the
single algorithm in [`activity.md`](activity.md), not an observation or
persistence time. `seenEvents` contains at most one record per event ID.

Duplicate persisted event IDs are malformed sync state and fail strict dataset
validation. Within one retrieval, repeated occurrences of an event ID may be
collapsed only when they produce the same canonical activity. If one ID maps
to conflicting canonical activity data, the provider data is malformed; fail
that person's sync without note mutation or successful-state advancement.

`lastAttemptAt` is operational metadata and need not become durable when a
state save fails. `lastSuccessfulSyncAt` records the latest per-person sync
whose intended effects completed safely. It is never an activity identity,
deduplication cursor, or proof of complete history. Polling state is provider
policy metadata, not activity identity.

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

For eligible events absent from `seenEvents`:

1. normalize each event using [`activity.md`](activity.md);
2. construct each canonical activity representation;
3. inspect the valid managed section from [`person-note.md`](person-note.md)
   as a multiset of exact entry occurrences;
4. process the unseen events in the final rendering order: provider activity
   timestamp descending, then provider event ID ascending in lexicographic
   string order;
5. for each event, consume at most one unused matching canonical entry
   occurrence. If one is available, do not append another line and record its
   event ID only after state persistence succeeds. If none is available,
   include the event as new activity.

One existing canonical line can therefore reconcile only one provider event.
Two distinct unseen events with identical canonical rendering and one existing
occurrence produce one reconciled event and one newly rendered occurrence. This
preserves multiplicity without placing provider event IDs in Markdown. The
managed-section account ID defined by [`person-note.md`](person-note.md) is
section-level identity metadata, not an event ID or deduplication record.

This supports re-follow and state-save recovery without adding provider event
IDs or sync-state metadata to Markdown. If a user deletes or rewrites an
already-seen entry while the follow remains active, the event remains seen and
is not automatically restored.

## Historical retention and merge

The set and order of existing canonical DevRadar activity entries in the
current valid managed section form the historical activity baseline. A sync
never removes an existing canonical activity entry merely because the current
provider retrieval no longer returns it. Existing entries remain available
after they leave GitHub's retrievable window; `seenEvents` is not a substitute
for the factual content needed to recreate them. Other arbitrary or
non-canonical content in the managed section follows the existing person-note
rule and has no historical preservation guarantee.

New eligible activities are merged into that baseline rather than rebuilding
the managed section solely from the current provider result. Retained entries
are ordered by provider activity timestamp descending; within each equal-
timestamp retained group, their existing relative order is preserved. Newly
rendered entries are ordered by provider activity timestamp descending and
provider event ID ascending, then inserted by timestamp so the final list
remains newest-first. For equal timestamps, newly rendered entries are placed
after the retained group at that timestamp, and multiple new entries retain
event-ID order. Absence from the current provider feed is never a deletion
signal.

The active follow retains enough seen IDs to prevent duplication for activity
that GitHub can still return. Event IDs may be pruned once they are safely
beyond the provider's documented retrievable horizon, so pruning must never
make an event that GitHub can still return appear unseen. The exact pruning
algorithm and schedule are implementation details; retaining IDs for the
active follow is a valid implementation until safe pruning is available.
Unfollowing removes that active state and creates no inactive-person tombstone.

## Per-person sync boundary

Use one process-local application mutation boundary shared by Sync One, Sync
All, follow and re-follow, note-path changes, tracking-start changes,
unfollow, and plugin-owned settings saves. A sync acquires this boundary before
reading its followed-person configuration and holds it through provider
retrieval, note mutation, and sync-state persistence. A configuration
operation holds the same boundary through validation, note preparation, and
settings persistence. The exact mutex or API is an implementation detail.

No sync may commit note or sync-state effects using a followed-person
configuration that changed during that operation. No configuration mutation
may commit while a sync is using the relevant configuration. Global
`githubRequestPolicy` updates use this same boundary.

A permitted per-person sync follows this logical order:

```text
acquire global application mutation ownership
→ validate and snapshot settings
→ honor global and per-person provider-policy boundaries
→ retrieve all required provider pages
→ normalize supported activity
→ apply tracking-start and activity eligibility
→ deduplicate by canonical provider event ID
→ validate the associated note and managed range
→ reconcile canonical entries against the validated managed section
→ compute preflight intended Markdown
→ suppress mutation invocation for a safe semantic no-op, or revalidate/recompute
  from current content and pass the current-content result through the supported
  mutation boundary
→ persist newly seen IDs and successful provider state
→ record successful completion
→ release global sync ownership
```

The implementation may organize modules differently, but it must preserve the
following invariants:

- Required retrieval completes before note mutation or successful state
  advancement.
- A required later-page failure leaves the note, seen IDs, and
  `lastSuccessfulSyncAt` at their previous last-known-good values.
- New events are marked seen only after note accounting.
- A note write is never destructively rolled back when a later state save
  fails.
- A later sync recovers after that state-save failure through canonical
  reconciliation.
- Identical resulting Markdown has the semantic outcome `unchanged`. Safe
  preflight may suppress invoking the mutation primitive only when it proves
  both that the intended Markdown is identical to the observed note content
  and that no note-derived reconciliation or successful-state advancement
  depends on that snapshot. Otherwise, the final mutation boundary must
  operate on current vault content, even when the resulting Markdown is
  unchanged. This contract does not claim anything about unobservable physical
  filesystem I/O inside Obsidian.

Provider-policy metadata such as a newly observed poll boundary or retry
boundary may be persisted after a failed attempt when necessary to prevent an
invalid future request. It must not be confused with successful representation
state.

## Successful and failed outcomes

The per-person outcome is one of:

- `updated`: complete successful retrieval changed the note;
- `unchanged`: complete successful retrieval caused no note change;
- `failed`: an attempted operation could not complete safely;
- `skipped`: no request was attempted because an approved provider policy or
  provider-wide block prohibited it.

Successful completion may advance `lastSuccessfulSyncAt` and newly accounted
event IDs. A failed attempt retains the previous successful state except for
safely observed attempt or provider-policy data.

## Configuration transitions

Changing a tracking start preserves notes, `seenEvents`, and successful-sync
metadata. The next sync can reconsider still-visible events under the new
boundary. This applies in both directions.

Changing a future global activity eligibility configuration preserves notes,
`seenEvents`, and successful-sync metadata for every followed person. Schema v1
has no such user-facing activity configuration.

Changing a note path preserves all sync, deduplication, successful-sync, and
polling continuity and does not migrate or rewrite the old note. Only future
unseen activity is written to the new destination.

## Overlap and Sync All

The application mutation boundary also prevents a configuration mutation from
overlapping Sync One or Sync All. While any sync is running, another sync or a
followed-person/configuration mutation cannot start. This is a deliberately
coarse process-local boundary for the v0.2.0 implementation; finer-grained
ownership can be introduced only with an equivalent stale-commit guarantee.

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
- event IDs with canonical decimal strings, leading zeroes, unsafe numeric
  values, and other invalid representations;
- distinct events with similar rendered facts;
- eligible versus filtered events entering `seenEvents`;
- an unseen event whose canonical entry already exists;
- two distinct unseen event IDs with identical rendering and only one existing
  canonical occurrence;
- reconstruction after missing state;
- re-follow with retained canonical history;
- newly rendered equal timestamps ordered by ascending provider event ID;
- manually reordered retained entries are sorted by timestamp, preserving
  relative order only within equal-timestamp groups;
- same-timestamp new entries are placed after the retained group;
- canonical history remains when it leaves the provider's retrievable window;
- equivalent ISO-8601 timestamps with offsets or trailing fractional zeroes
  producing one canonical UTC RFC 3339 representation;
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
- tracking-start changes reconsidering still-available history;
- note-path change preserving continuity without old-note migration;
- repeated successful sync with no provider change;
- identical Markdown producing the semantic outcome `unchanged`, without a
  physical-write guarantee.

### Concurrency and partial failure

- Sync One and Sync All cannot overlap;
- two Sync All operations cannot overlap;
- a note-path, tracking-start, unfollow, or follow mutation cannot commit during
  an in-flight sync;
- a sync cannot commit after its followed-person configuration has changed;
- global provider-policy state cannot race a settings save;
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
