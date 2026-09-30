# Issue #141 — Safely Change a Followed Person’s Note Destination

## Delivery identity

- Repository: `FerdiHS/devradar`
- Issue: #141, `feat(follow): safely change a followed person's note destination`
- Branch: `feat/follow-note-destination-141`
- Base: `origin/main` at `1dd85fb324db35a3cd57683f53f6d7117f05e393`
- Worktree: `/Users/ferdi/.codex/worktrees/3ada/devradar` (isolated managed worktree)
- Assurance: High — persistence and synchronization continuity.
- Local readiness only: no push, PR, issue, or release metadata mutation.

## Goal and contract

Let a user explicitly change where future activity for an existing followed person is written. Prepare the requested destination through the existing note-persistence boundary and make it authoritative only after a complete settings snapshot is persisted under the shared application mutation guard.

Preserve the old note byte-for-byte. Do not move, rename, delete, clean up, or migrate activity. Preserve the person's GitHub identity, tracking start, sync/deduplication continuity, successful-sync metadata, and all unrelated settings. If settings persistence fails after note preparation, retain the old configured path and leave any safely prepared destination in place. Do not infer a destination after a user independently moves or deletes the configured note.

### Authoritative contracts

- `docs/settings.md`
- `docs/person-note.md`
- `docs/sync.md`
- `docs/product-direction.md`
- Live Issue #141 and its acceptance criteria.
- #96 is closed and explicitly excluded editing existing follows; #141 owns that follow-up. #144 remains the downstream combined release validation issue, not a prerequisite.

### Material decisions and accepted plan-review findings

- A case-insensitive canonical equivalent of the current configured destination is an unchanged no-op.
- Reuse of a valid same-person managed section must validate reserved association Properties in both preflight and current-content callback. Missing Properties remain permitted; malformed, duplicate, case-colliding, mismatched, or wrong-type reserved values fail closed.
- Sync One after a path change must write to the new destination while retaining continuity state.
- Assert old note bytes stay exact and destination preparation targets only the requested new path.
- Settings recovery must preserve a visible partial-outcome message explaining the prior path remains authoritative and a safely prepared destination may remain.
- Share the existing association transform and mutation boundary; add no generic transaction/locking abstraction or dependency.

## Global constraints

- Keep the change issue-scoped and preserve the architecture's application/domain/adapter layering.
- Use only existing safe Obsidian vault APIs and the existing complete settings persistence contract.
- No GitHub requests are needed for changing the destination.
- Keep sync semantics, endpoint transport, activity selection, schema, and docs unchanged unless implementation evidence reveals a contradiction; record any ruling in the local ledger.
- Case-insensitive uniqueness is enforced against other followed people. Same-person case-only spelling changes return unchanged without note preparation or persistence.
- Existing malformed or conflicting note state fails closed. Never write outside the DevRadar-managed section or change the old note.
- Deterministic sanitized tests only; no live GitHub requests or personal vault.
- `npm run check` is required before local readiness.
- Do not stage/commit this plan, the ledger, briefs, reviewer packets, or other process state.

## Task 1 — Fail closed on conflicting Properties for note reuse

### Interface

- Produces: an adapter association-preparation path that rejects conflicting reserved Properties when reusing a same-person managed section, including a current-content recheck.
- Consumes: existing `inspectAssociationProperties` domain validation and `prepareAssociation` persistence port.

### Steps (RED → GREEN)

1. In `tests/obsidian-notes.test.ts`, update the reuse contract so absent or incomplete allowed Properties remain accepted, while mismatched account ID and wrong-type values fail. Add deterministic cases for malformed/duplicate/case-colliding reserved Properties and a race where Properties conflict in the current-content callback after preflight.
2. Run the focused adapter tests and observe the new unsafe-reuse cases fail against the current adapter.
3. Update `src/adapters/obsidian-notes.ts` to validate association Properties before reuse and immediately before applying the managed-section transform. Reject any non-valid inspection; do not add missing Properties to a reused note.
4. Run the focused adapter tests and confirm the new conflicts fail closed while missing Properties and valid same-person reuse still pass.

### Expected

- Only reserved association data that is absent/incomplete under the person-note contract or valid for the requested identity can proceed.
- Conflict appearing after preflight is rejected without writing note content.

### Commit

`fix(notes): reject conflicting properties when reusing associations`

## Task 2 — Application use case for changing note destination

### Interface

- Consumes Task 1's safe `NotePersistence.prepareAssociation` behavior.
- Produces a narrow `FollowManagementApplication.changeNotePath(githubAccountId, draftPath)` operation that shares the existing mutation guard and association transform with Follow.
- Preserves the current Sync One settings authority and note persistence dependency so path selection is read from authoritative settings at operation time.

### Steps (RED → GREEN)

1. In `tests/follow-management.test.ts`, add deterministic cases for successful changes to created/initialized/reused destinations; invalid and duplicate paths; missing follow; settings recovery; unsafe-note failure; persistence failure; pending guard; case-only no-op; and preservation of identity, tracking start, every sync/deduplication field, global settings, and other people.
2. Assert the exact old-note bytes are unchanged, preparation receives only the requested destination and selected identity, and no prepare/persist happens on a case-insensitive same-path no-op.
3. Add a narrow regression that, after a successful path change, Sync One reads/writes the new destination and still preserves its prior sync/deduplication state.
4. Run the focused management and Sync One tests; observe the new behavior fail before implementation.
5. Export/reuse the existing Follow association transform rather than duplicating note rules. Inject the existing note persistence port into FollowManagementApplication. Validate/canonicalize path via existing domain helper, check uniqueness against all other followed people case-insensitively, and hold the shared mutation guard through authoritative read, destination preparation, full-snapshot persistence, and authoritative runtime commit.
6. Prepare only the new path. Derive the complete candidate from current settings, changing only the selected person's note path. On note or persistence failure keep old settings authoritative; never destructively undo prepared note content. Map failures to stable reasons `invalid-input`, `settings-not-ready`, `not-followed`, `duplicate`, `note`, `persistence`, or `internal`.
7. Confirm the focused tests pass and inspect continuity and exact old-note byte assertions.

### Expected

- Successful path changes preserve all unrelated settings/person state and make future Sync One use the new path.
- Unsafe inputs/preparation and failed persistence leave the previous path authoritative.
- Case-only path changes return unchanged without side effects.

### Commit

`feat(follow): safely change a followed person's note destination`

## Task 3 — Settings UI, host wiring, and recovery outcome

### Interface

- Consumes Task 2's typed application outcome and `changeNotePath` host callback.
- Produces an action in both declarative and legacy settings surfaces, wired through `src/main.ts` to the same `NotePersistence` instance used by Follow and Sync.

### Steps (RED → GREEN)

1. Add focused UI tests in `tests/settings-ui.test.ts` for beginning an edit keyed by GitHub account ID, prefilled path, save/cancel, pending and unchanged outcomes, stable failure display, and persistence-failure messaging surviving recovery UI. Update host fixtures with the typed operation.
2. Add wiring tests in `tests/main.test.ts` proving plugin composition forwards the chosen account ID/path and receives the structured result.
3. Run the focused UI and main tests and observe the new cases fail before implementation.
4. Extend host types and both settings renderers with an “Edit note destination” control. Keep UI limited to collecting input and presenting typed outcomes; avoid direct note/settings persistence. Ensure failure after preparation remains visible in recovery, stating the old path is still configured and the new note may have been safely prepared.
5. Wire `FollowManagementApplication` with existing notes persistence in `src/main.ts`; forward the host action without adding adapter APIs or changing transport.
6. Run focused UI and main tests and verify recovery mode retains the partial-outcome message.

### Expected

- Both supported settings surfaces expose the edit and recovery outcome.
- Composition routes the operation to the same application/note/settings/mutation boundaries.

### Commit

`feat(settings): expose followed-person note destination editing`

## Acceptance

- Old note bytes and all user-owned content outside managed sections remain unchanged.
- New activity targets the new destination and sync/deduplication continuity persists.
- Invalid paths, duplicate paths, unsafe marker/Properties state, and persistence failure leave the old path authoritative.
- Destination dispositions and failure states have deterministic focused coverage.
- Existing Follow/re-follow association rules remain intact.
- `npm run check` passes.
- Recheck the live Issue #141 criteria, inspect the full base-to-HEAD diff, and complete exactly two independent final reviews: Acceptance/Requirements and Code Quality/Risk.

## Review focus

- Check ordering and authority across association preparation, complete settings persistence, and runtime commit under the shared guard.
- Look for any old-note write/move/delete or accidental user-content mutation.
- Verify canonical path and case-insensitive uniqueness behavior, reserved Properties checks, and current-content race handling.
- Inspect failure/recovery status visibility and sync continuity after destination change.
- Ensure no process artifacts, broad refactors, undocumented APIs, Node/Electron dependencies, or transport/scope expansion entered the branch.
