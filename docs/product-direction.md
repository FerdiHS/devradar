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
4. Configure one global set of enabled activity types.
5. Manually run either:
   - **Sync all followed people**; or
   - **Sync one person**.
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
- stop with an actionable error when managed markers are malformed, duplicated, missing, or ambiguous;
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

The exact managed-marker syntax and complete note template are intentionally deferred to a separate specification.

## Activity and retention boundaries

For the MVP, “meaningful activity” means a supported activity type enabled in the single global activity configuration.

The exact supported activity catalogue and its default enabled types are intentionally deferred to a separate specification.

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

The MVP is successful when it reliably:

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

## Deferred specifications

This product contract intentionally does not define:

- the exact activity catalogue and default enabled types;
- the complete person-note template;
- managed-marker syntax;
- the persisted settings schema;
- GitHub event mapping;
- deduplication and sync-state design;
- detailed error and rate-limit behaviour;
- persistence interfaces or GitHub API adapters;
- layered architecture;
- the implementation plan.

Each area must be addressed through a focused follow-up specification or planning issue before its implementation proceeds.
