# DevRadar settings and followed-person specification

This document resolves the persisted followed-person configuration and
lifecycle contract for
[Issue #62](https://github.com/FerdiHS/devradar/issues/62). It defines data
and behavior only; it does not implement settings UI, GitHub requests, note
writing, or synchronization.

## Schema version

The persisted settings schema is independent from DevRadar plugin SemVer.
Schema version `1` identifies the interpretation of the persisted data.

The canonical shape is:

```ts
type DevRadarSettingsV1 = {
	schemaVersion: 1;
	followedPeople: Array<FollowedPersonV1>;
	githubRequestPolicy?: GitHubRequestPolicyV1;
};

type FollowedPersonV1 = {
	username: string;
	githubAccountId: string;
	notePath: string;
	trackingStart:
		| { mode: 'from-now'; at: string }
		| { mode: 'available-recent' }
		| { mode: 'from-date'; at: string };
	syncState: PersonSyncState;
};

type GitHubRequestPolicyV1 = {
	rateLimitNotBefore?: string;
};
```

`PersonSyncState` is the plugin-owned internal state defined by
[`sync.md`](sync.md). User-controlled configuration and internal provider/sync
metadata remain conceptually separate even though they are persisted in one
followed-person record. `githubRequestPolicy` is plugin-owned global provider
state, not followed-person configuration. Its absence means that no
provider-wide rate-limit boundary is currently known.

Every GitHub request, including identity resolution before a follow association
exists, must consult `githubRequestPolicy.rateLimitNotBefore`. A future value
means no request may be started and the operation returns `skipped`. A reached
value may be cleared before the next request. Updating or removing one followed
person must not clear this global state.

Absent saved data and the known legacy value `{}` are valid empty input and
behave as an empty schema-v1 configuration. Arbitrary non-empty unversioned
objects are not heuristically migrated. An understood schema version is
validated strictly before normal operation. A future schema version fails
closed: it is not partially interpreted, downgraded, discarded, or replaced
with defaults.

## Followed-person identity

The canonical GitHub `login` returned by the documented identity lookup is the
user-facing MVP identity. Persist the same lookup's durable numeric GitHub user
ID as the canonical account binding, represented as a positive decimal string
to avoid numeric-width assumptions. Entered usernames are draft input until
that lookup succeeds.

Username and account-ID uniqueness are both required. After a follow
association is successfully committed, the username, account ID, and their
binding are immutable through ordinary edits. A wrong-account correction
requires unfollowing and creating a new follow association; DevRadar never
infers username changes or silently retargets notes and activity.

## Note paths

Persist note paths as canonical, non-empty, vault-relative Markdown paths using
`/` separators and ending in `.md`, such as `People/octocat.md`.

Normalize only harmless syntax such as separators and `.` components before
persistence. Reject:

- empty paths;
- POSIX absolute paths;
- drive-letter absolute paths;
- UNC or other network-style paths;
- NUL characters;
- `..` traversal or vault-escaping paths;
- paths without the `.md` extension.

Effective note paths are unique case-insensitively after canonicalization.
Equivalent paths such as `People/Alice.md` and `people/alice.md` cannot belong
to different followed people. Do not invent operating-system restrictions
unrelated to vault containment.

## Tracking start

The three product choices retain distinct persisted semantics:

```json
{ "mode": "from-now", "at": "2026-08-12T01:00:00.000Z" }
```

```json
{ "mode": "available-recent" }
```

```json
{ "mode": "from-date", "at": "2026-08-01T12:00:00.000Z" }
```

`from-now` resolves to the current instant when the follow or tracking-start
change is successfully committed. `available-recent` stores no invented
timestamp. `from-date` stores the selected instant in canonical UTC ISO-8601
form and rejects future times for the MVP.

Moving a start backwards may expose older activity still available from
GitHub, but never promises unavailable history. Moving it forwards never
deletes activity already recorded in a note.

## Follow lifecycle

Creating an association follows this order:

1. Validate draft username, path, and tracking start.
2. Resolve the GitHub identity and use its canonical `login`.
3. Validate username and effective note-path uniqueness.
4. Inspect and prepare the destination according to
   [`person-note.md`](person-note.md).
5. Initialize or reuse the correct same-person managed section.
6. Persist the followed-person configuration with empty internal sync state.

The association is not active until it can be safely persisted. If note
initialization succeeds but settings persistence fails, do not destructively
roll back the note; a later retry may reuse the valid same-person section.

## Note-path changes

Changing a note path is an explicit reassociation of the future destination.
Before committing the new path, validate uniqueness, inspect the destination,
and initialize or reuse it using the person-note rules.

A path change must not delete, move, rename, clean up, or migrate the old note
or its history. It must preserve synchronization continuity, deduplication
state, and successful-sync metadata. New activity uses the new destination.

If the user independently moves, renames, or deletes the configured note,
DevRadar does not infer the new path or recreate the old note. Sync fails for
that person until the user explicitly changes the configured path.

## Tracking-start changes

Tracking-start changes affect future retrieval eligibility only. They never
prune recorded Markdown activity. The sync contract invalidates reusable
provider cache state so the next sync can reconsider still-available history
under the new boundary.

## Unfollow and re-follow

Unfollowing removes the active followed-person record and its internal
provider/sync/deduplication state. It preserves the Markdown note, managed
section, recorded activity, and user content. It creates no inactive-person
tombstone.

Re-following is a new association. The user chooses the path and tracking start
again. A valid same-person managed section may be reused. The sync contract's
canonical reconciliation prevents duplicate activity when the canonical entry
remains intact; arbitrary manual rewriting cannot be treated as reliable
provider identity.

## Validation and recovery

Known schema-v1 data is rejected as a dataset when it contains:

- duplicate usernames or effective note paths;
- duplicate GitHub account IDs;
- malformed usernames or note paths;
- missing, malformed, or inconsistent GitHub account IDs;
- malformed tracking-start variants or timestamps;
- future selected dates;
- incorrect JSON value types;
- unexpected fields in the strict schema;
- structurally invalid followed-person or sync-state records.
- malformed global GitHub request-policy state;

Do not silently discard malformed records, continue with a partial dataset,
guess repairs, choose winners for duplicates, or overwrite original malformed
data with defaults. Report an actionable dataset-level integrity error.

This is distinct from a runtime GitHub or note failure for one person after the
configuration has been validated; those failures remain person-scoped unless
the provider contract says otherwise.

Schema v1 contains no activity-category subscription field. The fixed activity
scope is defined by [`activity.md`](activity.md); category controls belong to a
future schema and milestone.

The implementation test matrix must cover a rate-limit boundary observed while
following one person blocking Sync One for another person, identity lookup
consulting the same boundary before an association exists, and unfollowing not
clearing the boundary.
