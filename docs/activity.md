# DevRadar activity specification

This document resolves the activity catalogue and GitHub event mapping for
[Issue #60](https://github.com/FerdiHS/devradar/issues/60). It is a semantic
contract, not an implementation of event mappers.

## Product boundary

DevRadar records minimal, factual, public developer activity for explicitly
followed GitHub users. Activity is deterministic and must not depend on AI,
inferred importance, behavioural conclusions, scoring, or ranking.

GitHub event types and actions are provider inputs. They are not the primary
DevRadar domain identity. A normalized activity has a DevRadar family and
action, provider event ID, provider timestamp, repository identity, minimal
factual metadata, a safe source link where one can be derived, and limited
provider provenance for diagnostics and reconciliation.

The activity history is recent, bounded, delayed, and not exhaustive. DevRadar
does not promise every commit, complete contribution history, or real-time
collection.

## Activity families

The complete people-first MVP catalogue contains:

1. Pushes
2. Pull requests
3. Pull-request reviews
4. Issues
5. Comments
6. Discussions
7. Releases
8. Repository forks
9. Branches and tags

The `v0.2.0` implementation slice enables only Pushes, Pull requests, and
Issues. The other families are documented here so later implementation can use
the same stable semantic model. There are no per-family controls in
`v0.2.0`.

## Canonical mapping table

The table is the complete mapping contract. `id`, `created_at`, and repository
identity are required for every supported row. A row's event-specific required
fields are also required. Optional fields may be absent without invalidating
the activity; the corresponding metadata is omitted.

| GitHub event and action/condition                                                      | DevRadar family and action           | Event-specific required data                                                                                | Optional metadata and semantics                                                                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PushEvent` with its event-level push payload                                          | Pushes / `pushed`                    | `payload.ref`                                                                                               | `payload.head`, `payload.before`; preserve the full ref so branch/tag identity is factual. One event produces one activity, never one per commit. |
| `PullRequestEvent` / `opened`                                                          | Pull requests / `opened`             | `payload.number`, `payload.pull_request.title`, canonical pull-request source URL                           | Base/head branch details and actor metadata.                                                                                                      |
| `PullRequestEvent` / `reopened`                                                        | Pull requests / `reopened`           | `payload.number`, `payload.pull_request.title`, canonical pull-request source URL                           | Base/head branch details and actor metadata.                                                                                                      |
| `PullRequestEvent` / `closed` with `payload.pull_request.merged === false`             | Pull requests / `closed`             | `payload.number`, `payload.pull_request.title`, canonical pull-request source URL, a valid non-merged state | Merge metadata is not rendered.                                                                                                                   |
| `PullRequestEvent` / `merged`, or `closed` with `payload.pull_request.merged === true` | Pull requests / `merged`             | `payload.number`, `payload.pull_request.title`, canonical pull-request source URL, a valid merged state     | Merge commit metadata is optional. Merged and closed-without-merge remain distinct.                                                               |
| `IssuesEvent` / `opened`                                                               | Issues / `opened`                    | `payload.issue.number`, `payload.issue.title`, canonical issue source URL                                   | Actor metadata.                                                                                                                                   |
| `IssuesEvent` / `reopened`                                                             | Issues / `reopened`                  | `payload.issue.number`, `payload.issue.title`, canonical issue source URL                                   | Actor metadata.                                                                                                                                   |
| `IssuesEvent` / `closed`                                                               | Issues / `closed`                    | `payload.issue.number`, `payload.issue.title`, canonical issue source URL                                   | Actor metadata.                                                                                                                                   |
| `PullRequestReviewEvent` / `created`                                                   | Pull-request reviews / `created`     | `payload.pull_request.number`, canonical pull-request source URL, review identity                           | Review state and body are optional; full review text is never retained. `updated` and `dismissed` are intentionally unsupported actions.          |
| `IssueCommentEvent` / `created`                                                        | Comments / `issue-comment`           | `payload.issue.number`, canonical issue or pull-request source URL, canonical comment source URL            | Issue or pull-request title and a short factual rendering field. Full comment text is not retained.                                               |
| `PullRequestReviewCommentEvent` / `created`                                            | Comments / `review-comment`          | `payload.pull_request.number`, canonical pull-request source URL, canonical comment source URL              | Path, line, and a short factual rendering field. Full comment text is not retained.                                                               |
| `CommitCommentEvent` / `created`                                                       | Comments / `commit-comment`          | canonical repository identity and canonical comment source URL                                              | Commit identity and a short factual rendering field. Full comment text is not retained.                                                           |
| `DiscussionEvent` / `created`                                                          | Discussions / `created`              | discussion identity, title, canonical discussion source URL                                                 | Category and actor metadata. Discussion comments have no separate supported Events API mapping in this catalogue.                                 |
| `ReleaseEvent` / `published`                                                           | Releases / `published`               | release identity, tag identity, canonical release source URL                                                | Release title/name. Release body is not retained. Other release actions are unsupported.                                                          |
| `ForkEvent` / `forked`                                                                 | Repository forks / `forked`          | canonical source repository identity and `payload.forkee` identity/source URL                               | Forked repository display name.                                                                                                                   |
| `CreateEvent` with `payload.ref_type === "branch"`                                     | Branches and tags / `branch-created` | `payload.ref`, `payload.ref_type`, canonical repository identity                                            | `payload.full_ref`. Repository creation is not a branch/tag activity.                                                                             |
| `CreateEvent` with `payload.ref_type === "tag"`                                        | Branches and tags / `tag-created`    | `payload.ref`, `payload.ref_type`, canonical repository identity                                            | `payload.full_ref`.                                                                                                                               |
| `DeleteEvent` with `payload.ref_type === "branch"`                                     | Branches and tags / `branch-deleted` | `payload.ref`, `payload.ref_type`, canonical repository identity                                            | `payload.full_ref` when present.                                                                                                                  |
| `DeleteEvent` with `payload.ref_type === "tag"`                                        | Branches and tags / `tag-deleted`    | `payload.ref`, `payload.ref_type`, canonical repository identity                                            | `payload.full_ref` when present.                                                                                                                  |

The supported event families and payload shapes are verified against the
[documented GitHub event types](https://docs.github.com/en/rest/using-the-rest-api/github-event-types?apiVersion=2026-03-10).

## Mapping validity and failure boundary

Mapping validity and provider failure are separate concerns:

- An unknown but structurally valid event type is ignored safely.
- A known event with an intentionally unsupported action is ignored safely.
- A supported mapping with missing or invalid required normalization data must
  not silently disappear. The GitHub boundary validates the raw response and
  classifies the resulting failure according to the
  [GitHub retrieval specification](github.md).
- A supported mapping missing an optional field still normalizes and omits
  only that optional metadata.
- Malformed response or page structure follows the provider-failure rules in
  `github.md`; it is not treated as an unsupported event.

Unsupported input must never become a generic "unknown activity" entry and
must not abort synchronization merely because GitHub adds a new event type.

## Normalized activity fields

The shared normalized representation contains:

- provider event ID for deduplication;
- semantic family;
- semantic action/kind;
- canonical UTC provider activity timestamp;
- canonical repository identity/name;
- relevant object number or identity where applicable;
- concise title where applicable;
- branch, tag, or ref where applicable;
- a canonical public source URL when it can be safely derived;
- minimal provider provenance needed for diagnostics and mapping.

Do not persist raw payloads, full issue bodies, pull-request descriptions,
comments, discussions, patches, source files, README content, or unnecessary
personal/repository metadata.

Provider event IDs and deduplication state are owned by the sync specification;
they are not rendered as hidden Markdown metadata.

## Pull-request and issue rules

Pull-request lifecycle actions are `opened`, `reopened`, `closed` without a
merge, and `merged`. Assignment, unassignment, labeling, and unlabeling do
not create standalone pull-request activity.

Issue lifecycle actions are `opened`, `reopened`, and `closed`. Assignment,
unassignment, labeling, and unlabeling do not create standalone issue
activity.

Repository stars and other events not explicitly listed in the mapping table
are outside this catalogue.

## Rendering boundary

Activity-specific factual fields are rendered through the person-note contract.
Provider text is untrusted and must be reduced to the smallest field-specific
single-line representation required by that contract. Markdown escaping,
marker containment, and validated source links are note-rendering concerns,
not reasons to retain raw provider payloads.

## Validation checklist

- The complete nine-family catalogue is present.
- The fixed `v0.2.0` subset is exactly Pushes, Pull requests, and Issues.
- Every supported row has required and optional fields.
- Comments, Discussions, and Create/Delete branch/tag semantics are explicit.
- Merged and closed-without-merge pull requests are distinct.
- One `PushEvent` is one activity.
- Unknown event types and unsupported actions are safely ignored.
- Required mapping data cannot silently disappear.
- All mappings use documented GitHub Events API inputs.
- No wording promises exhaustive, real-time, or complete history.
