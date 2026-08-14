# DevRadar MVP architecture

## Purpose and authority

This document is the normative architecture for DevRadar's people-first MVP
and its `v0.2.0` implementation slice. It assigns architectural ownership and
integration boundaries; it does not create a source layout, module list, or
runtime API.

[Product direction](product-direction.md) remains authoritative for product
scope and non-goals. Detailed activity, note, settings, synchronization, and
GitHub behavior remain authoritative in the respective [activity](activity.md),
[person-note](person-note.md), [settings](settings.md), [synchronization](sync.md),
and [GitHub retrieval](github.md) specifications. This document must not be
read to relax or replace those contracts.

## Dependency direction

```text
thin plugin lifecycle and UI composition
  -> depends on application use cases and policy
       -> depends on domain logic
       -> depends on application-owned capability ports

GitHub adapter  -> implements applicable application-owned capability ports
Obsidian adapter -> implements applicable application-owned capability ports
```

The `depends on` arrows describe dependency ownership, not runtime data flow.
Domain logic does not depend on Obsidian, GitHub HTTP, raw provider payloads,
or plugin/UI code. The application depends on domain concepts and on its own
capability ports; the plugin and UI compose it with concrete adapters. Runtime
requests and results pass through those ports under application coordination,
not directly between adapters. The plugin and UI do not contain the core sync,
lifecycle, reconciliation, or persistence policy.

This is a conceptual boundary, not a prescribed directory tree or a request to
create interfaces in advance. Application-owned capability ports stay narrow
and are introduced only when a use case needs them, such as retrieving a
resolved identity and complete activity result, reading or replacing a
managed note section, and loading or saving validated settings/state. Their
concrete shape is an implementation decision that must preserve these
boundaries. The application owns these ports, each adapter implements the
ports applicable to its boundary, and adapters never call each other directly;
the application coordinates their work.

## Responsibilities and testability

- The **domain** owns provider-independent activity meaning, canonical
  identity/reconciliation rules, tracking eligibility, and managed-content
  decisions as defined by the detailed contracts.
- The **application** owns follow lifecycle orchestration, Sync One ordering,
  outcomes, mutation ownership, and the commit ordering between retrieval,
  note mutation, and persisted state.
- The **GitHub adapter** owns `requestUrl()` requests, documented REST request
  construction, HTTP status/headers, pagination-link validation, raw payload
  validation, and conversion of provider responses into the data and
  provider-policy observations required by the application.
- The **Obsidian adapter** owns vault note discovery, safe note reads/creates
  and managed-range writes, plus loading and saving settings and plugin-owned
  state. It confines Obsidian APIs and their persistence behavior to that
  boundary.
- The **plugin lifecycle** loads, wires, and disposes the composed
  application. It remains lifecycle-only.
- The **UI** collects explicit user actions and presents application results.
  It does not interpret raw GitHub data, mutate vault content directly, or
  bypass application policy.

Domain and application behavior must be testable without Obsidian. Tests use
sanitized fixtures and capability substitutes rather than live GitHub calls or
a vault; adapter tests cover the provider and Obsidian boundary behavior they
own.

Raw GitHub payloads and HTTP details stop at the GitHub adapter. Vault writes,
note bytes, and settings persistence stop at the Obsidian adapter. The domain
and application exchange validated, minimal information rather than leaking
either external representation across the boundary.

## Shared mutation boundary

One coarse, process-local application mutation boundary serializes all
state-changing operations: Sync One; follow and re-follow; note-path and
tracking-start changes; unfollow; plugin-owned settings saves; and global
provider-policy updates. A future Sync All operation uses this same boundary.
The implementation mechanism is deliberately unspecified, but it must prevent
stale configuration commits and overlapping sync/configuration mutations.

Malformed persisted configuration and an already-active synchronization are
run-scoped failures: where possible, they fail before any GitHub request or
note mutation. They are distinct from a failure while synchronizing one
validated person, which may permit a future Sync All run to continue, and from
a provider-wide boundary, which stops further requests and skips people not
yet attempted.

For a permitted Sync One, the application preserves this order:

```text
acquire guard
-> validate and snapshot state
-> honor poll boundaries
-> retrieve all required pages
-> normalize, filter, and deduplicate
-> validate note
-> compute managed-section replacement
-> write only changed content
-> persist successful state
-> report outcome
-> release guard
```

Retrieval must be complete before a note change, deduplication advance, ETag
advance, or successful-sync state advance. A safe provider-policy boundary,
such as a poll, retry, or rate-limit boundary, may persist after failed
retrieval when doing so prevents an invalid later request. That exception never
permits note mutation, deduplication state, ETag, or successful-sync state to
advance after incomplete retrieval. A note write is not destructively rolled
back if a later state save fails: the changed note remains, the operation
reports failure, and successful-sync state does not advance. Later canonical
reconciliation can recover from that state-save failure.

The application reports `updated`, `unchanged`, `failed`, or narrowly defined
`skipped` outcomes. `skipped` means no person request was attempted because an
approved polling, rate-limit, or provider-wide boundary prohibited it; it does
not mask an attempted failure.

## Trust, data, and failure boundaries

GitHub is an untrusted public-data boundary. Validate identities, events,
pagination targets, provider text, and source URLs before they affect domain
data or Markdown. Use only the documented public REST contract described in
[GitHub retrieval](github.md), and retain only the minimal factual data needed
for the local workflow. Raw payloads, bodies, descriptions, comments, patches,
and unrelated profile data are not retained.

The vault and its settings are also a trust boundary. Validate settings and
safe vault-relative Markdown paths before persistence; reject malformed or
ambiguous state rather than guessing repairs. During sync of an associated
note, a note may change only inside one unambiguous, identity-matching
DevRadar-managed section. During explicit initial association only, a
marker-free existing note may receive its first managed section at EOF as
defined by [person-note](person-note.md). Preserve every byte outside that
range, avoid writes when resulting content is unchanged, and never
automatically overwrite a whole note, delete, move, rename, or recreate an
associated note. Generated text and links remain contained in that managed
range and use the detailed safe rendering rules.

Provider, validation, retrieval, and pre-write note failures for one person
preserve that person's existing note and prior successful state. If a note
write succeeds but a later plugin-state save fails, the changed note remains,
the operation reports failure, and successful-sync state does not advance;
later canonical reconciliation can recover. In a future Sync All run,
completed person updates remain committed, ordinary person failures do not
roll back other people, and a provider-wide boundary stops further requests so
unattempted people are `skipped`. No operation uses destructive rollback to
simulate atomicity across the vault and persisted settings.

## Compatibility and MVP slice

DevRadar supports Obsidian Desktop and Mobile and declares
`isDesktopOnly: false`. The unauthenticated MVP uses Obsidian's `requestUrl()`
with documented GitHub REST APIs. Runtime code must remain browser-compatible:
it excludes Node.js filesystem APIs, Electron-only APIs, shell execution, and
desktop-only dependencies.

The exact `v0.2.0` Sync One slice is people-first and supports multiple
followed people, canonical per-person note paths and tracking starts,
follow-time identity resolution, and only Pushes, Pull requests, and Issues.
It includes complete retrieval, safe managed-note mutation,
deduplication/idempotency, state-save recovery, overlap prevention, and the
`updated`/`unchanged`/`failed`/narrowly-defined-`skipped` outcomes above.

Sync All implementation, activity controls, and other post-`v0.2.0` work are
explicitly deferred. Product-excluded themes—including AI judgment, scoring,
recruitment or employee monitoring, outreach, lead generation, monetization,
and hosted or telemetry-based features—remain non-goals unless a
product-direction decision changes them.
