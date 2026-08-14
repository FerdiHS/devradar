# DevRadar product direction and MVP boundaries

## Purpose and authority

This document defines the approved product direction and MVP boundaries for DevRadar. It reflects the decisions recorded in [Issue #1](https://github.com/FerdiHS/devradar/issues/1) and acts as the product contract for later specification and implementation work.

DevRadar is a local-first Obsidian Community Plugin for following selected GitHub users and recording supported public developer activity in connected Markdown person notes.

This document defines product behaviour and scope. It does not settle lower-level technical design. Implementation work must remain consistent with these boundaries, and unresolved details must be addressed through focused follow-up specification issues rather than decided accidentally during implementation.

## Product direction

The initial product is:

- an Obsidian Community Plugin;
- local-first and privacy-respecting;
- focused on GitHub users selected explicitly by the user;
- conservative when modifying existing Markdown notes;
- based only on documented and authorised GitHub APIs.

Product language should use terms such as **follow**, **track**, and **developer activity**.

DevRadar must not be positioned as stalking, surveillance, recruitment, employee monitoring, lead generation, scoring, ranking, contact enrichment, or automated outreach software.

Repository and organisation tracking may be considered only after the people-first Obsidian workflow has been validated.

## People-first MVP workflow

The MVP workflow is:

1. Add a GitHub username.
2. Select an existing Markdown note or specify a path for a new note.
3. Choose a per-person tracking start:
    - from now;
    - import available recent activity; or
    - a selected date and time.
4. Use the fixed `v0.2.0` activity subset of Pushes, Pull requests, and
   Issues. The complete people-first MVP may later configure one global set of
   enabled activity types.
5. In the complete people-first MVP, manually run either:
    - **Sync all followed people**; or
    - **Sync one person**.
      The `v0.2.0` implementation slice starts with Sync One.
6. Retrieve, normalise, filter, sort, and deduplicate supported activity.
7. Write new activity into a DevRadar-managed section of the selected note.
8. Report updates, unchanged people, rate-limit information where relevant, and partial failures.

Manual synchronisation is required for the MVP. Startup, scheduled, and real-time synchronisation are excluded.

## Followed-person model and lifecycle

Each followed person has:

- a GitHub username;
- one explicitly selected Markdown note path;
- a per-person tracking start time;
- last-sync and provider-specific metadata;
- deduplication state.

The same Markdown note must not be mapped to multiple followed people.

A user may later change a followed person's note path or tracking start time:

- A note-path change affects future activity only.
- DevRadar must not automatically move or erase historical content from the previous note.
- Moving the start time backwards only attempts to retrieve history that GitHub still exposes.
- DevRadar must not imply that unavailable history has been recovered or that the resulting history is complete.

Unfollowing a person stops future synchronisation but preserves their note and all activity already recorded.

If an account becomes unavailable, deleted, renamed, suspended, private, or otherwise inaccessible, DevRadar must preserve existing notes and activity and report the failure clearly. The MVP must not infer username changes automatically.

## Note ownership and safety

DevRadar owns only an explicitly marked managed section. The user owns everything else in the note.

DevRadar must:

- preserve all content outside its managed section;
- never overwrite an entire existing note;
- never automatically delete, rename, or move a note;
- leave unchanged notes untouched;
- stop with an actionable error when managed markers are malformed, duplicated,
  missing after association, foreign, or ambiguous; marker-free existing notes
  may be initialized only during explicit association as defined by the
  [person-note specification](person-note.md);
- never guess how to repair damaged or ambiguous marker structure;
- preserve successful person updates when another person fails;
- use safe Obsidian vault APIs.

Users may edit the managed section, but DevRadar may rewrite that section during a later sync. User-authored observations should remain outside the managed markers.

A newly created person note should contain only:

- a heading;
- the GitHub username;
- a public GitHub profile link;
- the DevRadar-managed section.

DevRadar must not copy unnecessary personal information into a new note.

The exact managed-marker syntax and complete note template are defined in the
[person-note specification](person-note.md).

## Activity and retention boundaries

For the complete people-first MVP, “meaningful activity” means a supported
activity type enabled in the single global activity configuration. The exact
supported activity catalogue is defined in the [activity specification](activity.md);
the eventual global activity-family configuration remains post-`v0.2.0` work.
The `v0.2.0` implementation slice has no activity-category setting and uses its
fixed Pushes, Pull requests, and Issues subset.

DevRadar must not use:

- AI-generated importance judgements;
- inferred importance;
- behavioural analysis;
- productivity judgements;
- scoring;
- ranking.

Recorded entries should contain minimal factual metadata and source links. DevRadar must not copy full issue bodies, pull-request descriptions, comments, discussions, patches, source files, or README content.

DevRadar must not promise every commit or a complete contribution history. A push is treated as one activity unless a later specification explicitly changes that rule.

Recorded activity is retained unless the user removes it. The MVP does not automatically prune recorded history.

## GitHub data and operational limitations

The unauthenticated MVP must:

- access public data only;
- use documented and authorised GitHub APIs;
- avoid scraping and undocumented endpoints;
- respect rate limits, polling guidance, and retry headers;
- use sequential requests unless controlled concurrency is justified later;
- stop rather than retry aggressively;
- never bypass GitHub limits;
- store only data required for the local workflow.

GitHub event history is recent, limited, delayed, and not real-time. DevRadar must not promise exhaustive history, every commit, complete contribution coverage, or real-time alerts.

Earlier tracking start times can retrieve only history that remains available through GitHub.

## Privacy and compatibility boundaries

The MVP is local-first. It has no requirement for:

- a backend;
- a cloud database;
- a DevRadar account;
- telemetry or analytics;
- automated publication;
- transmission of vault data;
- hosted infrastructure;
- monetisation.

Notes remain private unless the user independently publishes or synchronises their vault.

Obsidian Desktop and Mobile are both MVP requirements. DevRadar should avoid unnecessary Node.js, Electron, and desktop-only APIs so that the supported workflow remains practical on mobile.

## MVP success criteria

The complete people-first MVP is successful when it reliably satisfies the
following criteria. The `v0.2.0` implementation slice is narrower: it uses the
fixed Pushes, Pull requests, and Issues subset and implements Sync One only.

- follows explicitly configured GitHub users;
- supports per-person note paths and tracking start times;
- uses one global activity filter;
- supports **Sync all followed people** and **Sync one person**;
- retrieves supported recent public activity;
- creates missing person notes safely;
- updates existing notes only inside managed regions;
- prevents duplicate activity entries;
- avoids rewriting unchanged notes;
- preserves user-authored content;
- handles invalid users, unavailable accounts, API failures, malformed settings, and rate limits safely;
- continues Sync All after individual failures and reports partial success;
- prevents overlapping synchronisation;
- works on Obsidian Desktop and Mobile;
- passes repository quality checks;
- remains eligible for the Obsidian Community Plugin workflow.

## Explicit MVP exclusions

The initial MVP does not include:

- repository tracking;
- organisation tracking;
- private GitHub activity;
- GitHub authentication;
- startup synchronisation;
- scheduled synchronisation;
- real-time synchronisation or alerts;
- AI summaries or behavioural conclusions;
- scoring or ranking;
- recruitment or employee monitoring;
- lead generation, contact enrichment, or automated outreach;
- bulk people discovery;
- hosted infrastructure;
- telemetry or analytics;
- a standalone CLI;
- additional clients;
- automated publication;
- monetisation features.

Repositories, organisations, authentication, scheduling, and additional clients require separate validation and later issues.

## Follow-up specifications

The product contract remains authoritative for product scope and boundaries.
The following focused specifications now define the previously deferred
contracts without changing those product decisions:

- [activity catalogue and GitHub event mapping](activity.md);
- [person-note and managed-section format](person-note.md);
- [followed-person settings and lifecycle](settings.md);
- [synchronization state, deduplication, and idempotency](sync.md);
- [GitHub retrieval, pagination, rate limits, and failures](github.md).

The [MVP architecture](architecture.md) defines the current technical
integration boundaries without changing this product contract or its scope.
[Future directions](future-directions.md) are explicitly non-normative
possibilities and cannot change product decisions without separate approval.
Runtime implementation must satisfy this product contract, the focused
specifications above, and the current architecture.
