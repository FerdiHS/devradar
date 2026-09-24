# DevRadar settings and followed-person specification

This document resolves the persisted followed-person configuration, global
activity-family selection, and lifecycle contract for
[Issue #62](https://github.com/FerdiHS/devradar/issues/62) and the schema-v2
and filter changes in [Issue #121](https://github.com/FerdiHS/devradar/issues/121).
It defines data and behavior, including the global activity-family settings
control; it does not define GitHub requests, note writing, or synchronization.

## Schema version and migration

The persisted settings schema is independent from DevRadar plugin SemVer.
Schema version `2` is the current interpretation of persisted data. Schema
version `1` is the sole supported migration source.

The canonical shape is:

```ts
type DevRadarSettingsV1 = {
	schemaVersion: 1;
	followedPeople: Array<FollowedPersonV1>;
	githubRequestPolicy?: GitHubRequestPolicyV1;
};

type DevRadarSettingsV2 = {
	schemaVersion: 2;
	followedPeople: Array<FollowedPersonV1>;
	githubRequestPolicy?: GitHubRequestPolicyV1;
	enabledActivityFamilies: Array<'push' | 'pull-request' | 'issue'>;
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

`enabledActivityFamilies` is one global selection shared by every followed
person. Its only catalogue members are `push`, `pull-request`, and `issue`;
the persisted order is always that canonical catalogue order. Each member may
appear at most once, and an empty array is valid. No other activity family is
selectable in this release.

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

Absent saved data is a valid empty runtime value and is not eagerly written.
The known legacy value `{}` is valid empty schema-v1 input and is migrated to
schema v2 with all three implemented families enabled. A valid schema-v1
dataset is migrated losslessly for followed people, note paths, tracking
starts, sync/deduplication state, attempt/success metadata, polling metadata,
and global provider policy, with the three families added as the default
selection. Migration is persisted before the runtime becomes ready and is
performed under the shared application mutation boundary; a migration write
failure leaves settings in recovery and blocks GitHub and note work.

Schema-v1 and schema-v2 values are validated strictly. Schema v1 rejects the
v2-only `enabledActivityFamilies` field, while schema v2 requires it.
Arbitrary non-empty unversioned objects and malformed values are not
heuristically migrated. A schema version greater than `2` is a future-schema
recovery state: it is not partially interpreted, downgraded, discarded, or
replaced with defaults. Other malformed or unsafe values also fail closed.

Every persisted settings write is validated as schema v2. Runtime settings are
therefore always schema v2, even when the loaded data originated in schema v1.

### Obsidian plugin-data boundary evidence

On 2026-08-23, a temporary probe plugin was run in a disposable Obsidian
Desktop 1.13.7 vault. The probe observed:

- no plugin `data.json`: `await loadData()` returned `null`;
- `data.json` containing literal JSON `null`: `await loadData()` returned
  `null`;
- malformed `data.json` containing `{`: `await loadData()` returned `null`.

The first case had no data file; the latter two had a data file. Therefore
`loadData()` alone provides no presence bit, and the production boundary pairs
it with the public vault `DataAdapter.exists()` check. Only a missing file maps
to the domain absence sentinel; present `null` or malformed data remains a
validation failure.

This Desktop evidence does not authorize the Mobile path. Settings persistence
remains fail-closed on Obsidian Mobile until its capability-specific runtime
contract is separately validated.

### Issue #96 Desktop Follow smoke evidence

On 2026-08-29, the current production sources were built and loaded in a
disposable Obsidian Desktop 1.13.7 vault. Through the DevRadar settings tab,
the concrete Follow composition resolved the public GitHub identity for
`@torvalds`, persisted the association, and created a vault-relative Markdown
note containing the managed section and no activity records. A second Follow
for the same username with a different destination returned the stable
duplicate failure, left the followed-person list unchanged, and created no
second note.

This bounded smoke exercised Follow identity resolution, note preparation, and
complete settings persistence through the production composition. It did not
retrieve activity and does not authorize the Mobile path.

## Followed-person identity

The canonical GitHub `login` returned by the documented identity lookup is the
user-facing MVP identity. Persist the same lookup's durable numeric GitHub user
ID as the canonical account binding, represented as a positive decimal string
to avoid numeric-width assumptions. Entered usernames are draft input until
that lookup succeeds.

Draft usernames must be validated before identity request construction. A
username is 1–39 ASCII letters, digits, or hyphens, starts and ends with an
ASCII letter or digit, contains no consecutive hyphens, and contains no other
characters. The canonical login
returned by GitHub is validated by the same rule before persistence, request
path use, profile-link generation, or marker interpolation. This is the same
owner grammar used by [`activity.md`](activity.md).

Username and account-ID uniqueness are both required. After a follow
association is successfully committed, the username, account ID, and their
binding are immutable through ordinary edits. A wrong-account correction
requires unfollowing and creating a new follow association; DevRadar never
infers username changes or silently retargets notes and activity.

## Note paths

Persist note paths as canonical, non-empty, vault-relative Markdown paths using
`/` separators and ending in `.md`, such as `People/octocat.md`.

Draft/pre-persistence canonicalization may normalize only harmless syntax.
Reject prohibited raw forms before any separator normalization. In particular,
reject POSIX absolute paths, UNC/network paths, and drive-qualified forms such
as `C:foo`, `C:/foo`, and `C:\\foo`. Also reject:

- empty paths;
- NUL characters;
- ASCII control characters;
- `..` traversal or vault-escaping paths;
- trailing separators or empty final components;
- paths without the `.md` extension.

Permitted backslashes become `/`, repeated separators collapse, and `.`
components are removed. The required extension is the exact lowercase `.md`.
Persisted paths must already equal their canonicalized representation and are
rejected when they are merely repairable. Use case-insensitive comparison of
canonical paths for uniqueness. Do not invent unrelated operating-system
filename restrictions.

Effective note paths are unique case-insensitively after canonicalization.
Equivalent paths such as `People/Alice.md` and `people/alice.md` cannot belong
to different followed people.

## Timestamp representations

Plugin-owned persisted timestamps use the exact UTC millisecond form
`YYYY-MM-DDTHH:mm:ss.sssZ`. This includes tracking-start values and sync or
request-policy boundaries. They must already be canonical and are never
silently rewritten during persisted-settings validation.

Provider activity timestamps, including `seenEvents.createdAt`, use the
canonical precision-preserving algorithm defined by [`activity.md`](activity.md)
and must already equal that canonical representation when persisted.

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
timestamp. `from-date` requires a calendar date and accepts an optional local
time. When the time is omitted, it resolves to `00:00` at the start of the
selected date in the user's local timezone. The resulting local date/time is
converted to a canonical UTC ISO-8601 timestamp and stored in `from-date.at`;
future instants remain invalid for the MVP. The UI uses native `date` and
`time` controls, not free-form or locale-dependent parsing.

For `from-now` and `from-date`, an activity is eligible when its canonical
provider activity timestamp is equal to or later than the configured start
instant (`activityTimestamp >= trackingStart`).

Moving a start backwards may expose older activity still available from
GitHub, but never promises unavailable history. Moving it forwards never
deletes activity already recorded in a note.

## Follow lifecycle

Follow, re-follow, note-path changes, tracking-start changes, unfollow, and
plugin-owned settings saves acquire the shared process-local application
mutation boundary defined in [`sync.md`](sync.md). The operation holds it
through validation, any required GitHub identity lookup, note preparation, and
settings persistence. It cannot commit while a sync is active, and a sync
cannot commit using a configuration snapshot that this operation changed.

Creating an association follows this order:

1. Validate draft username, path, and tracking start.
2. Resolve the GitHub identity and use its canonical `login`.
3. Require a supported user account type and persist its durable account ID.
4. Validate username, account-ID, and effective note-path uniqueness.
5. Inspect and prepare the destination according to
   [`person-note.md`](person-note.md).
   Explicit association may add missing reserved identity Properties and fails
   closed on malformed or conflicting frontmatter.
6. Initialize or reuse the correct same-person managed section.
7. Persist the followed-person configuration with empty internal sync state.

The association is not active until note preparation and settings persistence
both succeed. If note initialization or Properties preparation succeeds but
settings persistence fails, do not destructively roll back the note; a later
retry may reuse it. Any property-only remnant is non-authoritative.

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
prune recorded Markdown activity. The next sync can reconsider still-available
history under the new boundary.

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
- duplicate `seenEvents.id` values or malformed `seenEvents.createdAt`
  timestamps;
- future resolved tracking-start instants;
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

The settings UI exposes the global activity-family selection as three
checkboxes and an explicit save action. Saving rereads the current authoritative
settings inside the shared mutation boundary and changes only
`enabledActivityFamilies`; it preserves followed people, notes, sync/deduplication
state, successful-sync metadata, polling metadata, and global provider policy.

The implementation test matrix must cover a rate-limit boundary observed while
following one person blocking Sync One for another person, identity lookup
consulting the same boundary before an association exists, and unfollowing not
clearing the boundary.

## Settings UI API compatibility decision

Evaluated 2026-09-24 against the [Obsidian Settings API documentation](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/User%20interface/Settings.md)
and its [migration guide](https://docs.obsidian.md/plugins/guides/migrate-declarative-settings).
These official docs establish that `getSettingDefinitions()` and native
settings-search indexing require Obsidian 1.13.0 or later. They document
`PluginSettingTab.display()` as a supported compatibility path for versions
below 1.13.0 and as a supported fallback on 1.13+. The documented dual-support
behavior calls `getSettingDefinitions()` and skips `display()` when the
definitions are non-empty on 1.13+, while versions below 1.13 continue to call
`display()`.

| Strategy                                         | Compatibility and search                                                                                              | Fit for DevRadar                                                                                                                                          | Maintenance cost                                                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep imperative `display()`                      | Retains the 1.4.4 floor; settings do not appear in native settings search on 1.13+.                                   | Preserves every current interaction and the existing application boundary.                                                                                | Lowest; one UI implementation.                                                                                                                                                |
| Add declarative definitions and keep `display()` | Retains the 1.4.4 floor; definitions are available to settings search on 1.13+, while older versions use `display()`. | Supported dual path. Declarative `render` and `action` rows can present custom interactions while dispatching only through the existing application host. | Highest of the two floor-preserving choices because both API surfaces must remain behaviorally aligned. Shared rendering helpers can reduce, but not remove, that obligation. |
| Migrate fully to declarative definitions         | Requires raising the floor to at least 1.13.0; settings become searchable on supported versions.                      | Custom `render` and `action` rows can represent DevRadar's interactions, but a full migration still must preserve application-owned mutations.            | One UI implementation after migration, with a compatibility and release change for existing users.                                                                            |

**Decision: adopt dual support in a separate implementation issue, while keeping
`minAppVersion: 1.4.4`.** Obsidian explicitly documents the dual-support path,
so the newer search capability can be offered without dropping older supported
versions. The maintenance cost is real, but it is bounded to the settings UI;
the existing floor is the default compatibility constraint and a separate
implementation issue can require parity between the two presentations. The
current issue does not implement that migration.

For the declarative surface, use custom `render` and `action` definitions for
DevRadar-managed interactions rather than default-bound `control` rows. The
default control path writes to `plugin.settings` and calls `saveData()` on each
change. Although Obsidian documents custom control getters and setters, the
activity-family UI intentionally keeps local drafts and saves explicitly, and
its application operation rereads authoritative state inside the shared
mutation boundary. Custom rows preserve these behaviors without introducing a
second editable settings source or a direct persistence path.

| Current interaction                                   | Declarative mapping for 1.13+                                                              | Required invariant                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Recovery diagnostics, Retry, and conditional Reset    | Named informational/render rows and action rows, refreshed from application state.         | Keep recovery fail-closed; expose Reset only for ordinary malformed data and route actions through the host. |
| Follow username, note path, and tracking-start drafts | Rendered inputs and a Follow action; show date/time controls only for date-based tracking. | Keep draft validation and asynchronous status local to the tab; submit only through `host.follow()`.         |
| Pending/error state and followed-person display       | Rendered status and read-only rows refreshed after host operations.                        | Never treat draft or recovery state as authoritative settings.                                               |
| Global activity-family selection                      | Rendered checkboxes plus an explicit Save action and pending/error feedback.               | Keep selection drafts local and call `host.saveActivityFamilies()` only on Save.                             |

These mappings intentionally preserve DevRadar's current workflows despite
Obsidian's guidance to save ordinary settings on change and use a modal for
multi-field forms. Declarative adoption must retain the explicit activity-
family Save action and the in-tab Follow draft/action; changing either is a
separate product and UX decision.

In both surfaces, settings authority remains in the existing validated
application and persistence layers. Writes continue through the serialized
mutation boundary; strict persisted-settings validation still precedes a
ready snapshot; persistence must succeed before a new snapshot becomes
authoritative. Retry/Reset, Follow, and activity-filter semantics remain
unchanged. The official docs also state that a non-empty declarative
definition set bypasses `display()` on 1.13+, and that imperative controls
inside an imperative settings page are not indexed. Therefore, every
search-relevant setting on 1.13+ must have an appropriate declarative
definition; a custom render row remains the escape hatch for its dynamic UI.
The implementation should call `update()` when asynchronous results change the
definitions or rendered content, and `refreshDomState()` when only
`visible`/`disabled` predicates need reevaluation. The below-1.13 fallback
continues to rebuild its imperative content through `display()`.
Keep stable configuration and action labels searchable. Mark per-person
definitions `searchable: false`; render transient status, error and recovery
details, usernames, and note paths as row content rather than definition names
or descriptions so runtime data does not enter the search index.

This recommendation gains settings-search support only on Obsidian 1.13.0+;
versions 1.4.4 through 1.12.x keep the current imperative UI and do not gain
native settings search. The documented API and compatibility behavior answer
the investigation's runtime-contract questions, so no separate runtime probe
was needed. The minimum version and release metadata remain unchanged.

**Follow-up:** create a separate implementation issue for dual support,
including search coverage on 1.13+, imperative fallback coverage below 1.13,
and preservation of the application mutation and recovery contracts. A
compatibility-floor or release-metadata issue is not required by this decision;
any later proposal to raise the floor needs explicit follow-up and approval.
