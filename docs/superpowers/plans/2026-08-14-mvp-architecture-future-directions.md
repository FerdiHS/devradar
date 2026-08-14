# Issue #65 — MVP Architecture Documentation

**Target plan artifact:** `/Users/ferdi/.codex/worktrees/8faf/devradar/docs/superpowers/plans/2026-08-14-mvp-architecture-future-directions.md`

## Summary

Deliver issue #65 as documentation-only work on branch `docs/architecture-mvp`, based on `main` at `11ce509`.

Create:

- `docs/architecture.md`: normative MVP architecture.
- `docs/future-directions.md`: explicitly non-normative future possibilities.

Update only the necessary navigation and authority references in `README.md`, `AGENTS.md`, and `docs/product-direction.md`.

No source modules, runtime behavior, API calls, dependencies, or generated files will be added.

## Key changes

1. **Normative architecture document**
    - Define layered dependency direction: domain → application → adapters, with thin plugin/UI composition.
    - Separate responsibilities for domain, application, GitHub, Obsidian, plugin, and UI layers.
    - Document conceptual application-owned ports without creating speculative interfaces or empty source directories.
    - Explicitly require domain/application logic to remain testable without Obsidian.
    - Confine GitHub payload/HTTP behavior to the GitHub adapter and vault/settings persistence to the Obsidian boundary.
    - Document the exact shared process-local mutation boundary for Sync One, follow/re-follow, path/start changes, unfollow, settings saves, and global provider-policy updates; future Sync All uses the same boundary.
    - Mirror the settled Sync One ordering: acquire guard, validate/snapshot state, honor polling boundaries, retrieve complete pages, normalize/filter/deduplicate, validate notes, compute managed-section changes, write only changed notes, persist successful state, report outcome, release guard.
    - Preserve the provider-policy exception: safe poll/rate-limit boundaries may persist after failed retrieval, while note changes, deduplication state, ETags, and successful-sync state may not advance.
    - Document GitHub/vault trust boundaries, managed-section containment, user-content preservation, minimal data collection, partial failures, provider-wide stopping, Desktop/Mobile compatibility, and `isDesktopOnly: false`.
    - Define the complete v0.2.0 Sync One vertical slice and explicitly defer Sync All implementation, activity controls, and other post-MVP work.

2. **Future-directions document**
    - Clearly state that entries are non-committed, non-normative, not implementation requirements, and not a roadmap.
    - Group plausible future themes without inventing designs or dates.
    - Treat product-direction exclusions such as AI judgment, scoring, recruitment, outreach, and monetization as explicit non-goals requiring a future product-direction decision—not as endorsed roadmap items.

3. **Cross-reference updates**
    - Add the architecture document to canonical contributor guidance.
    - Link both documents from README navigation, with future directions clearly labeled non-normative.
    - Update `docs/product-direction.md` so it remains authoritative while linking current architecture and speculative future directions.
    - Do not duplicate the architecture contract in `AGENTS.md`.

## Validation

- Review the documents against issue #65 and all settled contracts in `docs/activity.md`, `docs/person-note.md`, `docs/settings.md`, `docs/sync.md`, and `docs/github.md`.
- Compare architecture claims with `src/main.ts`, `src/settings.ts`, `manifest.json`, `AGENTS.md`, and `CONTRIBUTING.md`.
- Check for unresolved `TBD`/`TODO` architecture decisions.
- Verify all new relative links and referenced files.
- Confirm the issue delivery diff contains only the five intended documentation files; the required plan artifact is orchestration metadata.
- Run:

```bash
npm ci
npm run check
git diff --check
```

The planning-time `npm run check` could not run because dependencies are not installed (`prettier: command not found`); successful validation must be observed after dependency setup.

## Plan-review decisions

Two independent reviewers completed first-pass reviews. All findings were accepted and incorporated:

- Added explicit Obsidian-independent core testability and settings-contract validation.
- Added source-bootstrap comparison to acceptance review.
- Narrowed the architecture document to conceptual boundaries and cross-references instead of duplicating detailed specifications.
- Corrected sync ordering, mutation-guard scope, and provider-policy failure semantics.
- Separated product non-goals from speculative future directions.
- Kept only the architecture document canonical in `AGENTS.md`; future directions remain clearly non-normative.

No findings were rejected or deferred.

## Assumptions

- Issue #65 is the sole delivery group; issues #60–#64 remain read-only authoritative dependencies.
- No visual architecture diagram is needed; a text dependency graph is sufficient.
- This Plan Mode turn was read-only; the target plan path is now materialized for implementation recovery.
