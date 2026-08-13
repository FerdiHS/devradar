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

| GitHub event and action/condition                                                      | DevRadar family and action           | Event-specific required data                                                                                                                                             | Optional metadata and semantics                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `PushEvent` with its event-level push payload                                          | Pushes / `pushed`                    | `payload.ref`                                                                                                                                                            | `payload.head`, `payload.before`; one event produces one activity, never one per commit.                                     |
| `PullRequestEvent` / `opened`                                                          | Pull requests / `opened`             | `payload.number`, `payload.pull_request.title`, canonical pull-request source URL                                                                                        | Base/head branch details.                                                                                                    |
| `PullRequestEvent` / `reopened`                                                        | Pull requests / `reopened`           | `payload.number`, `payload.pull_request.title`, canonical pull-request source URL                                                                                        | Base/head branch details.                                                                                                    |
| `PullRequestEvent` / `closed` with `payload.pull_request.merged === false`             | Pull requests / `closed`             | `payload.number`, `payload.pull_request.title`, `payload.pull_request.merged === false`, canonical pull-request source URL                                               | Merge metadata is not rendered.                                                                                              |
| `PullRequestEvent` / `merged`, or `closed` with `payload.pull_request.merged === true` | Pull requests / `merged`             | `payload.number`, `payload.pull_request.title`, `payload.pull_request.merged === true`, canonical pull-request source URL                                                | Merge commit metadata is optional.                                                                                           |
| `IssuesEvent` / `opened`                                                               | Issues / `opened`                    | `payload.issue.number`, `payload.issue.title`, canonical issue source URL                                                                                                | No optional activity metadata.                                                                                               |
| `IssuesEvent` / `reopened`                                                             | Issues / `reopened`                  | `payload.issue.number`, `payload.issue.title`, canonical issue source URL                                                                                                | No optional activity metadata.                                                                                               |
| `IssuesEvent` / `closed`                                                               | Issues / `closed`                    | `payload.issue.number`, `payload.issue.title`, canonical issue source URL                                                                                                | No optional activity metadata.                                                                                               |
| `PullRequestReviewEvent` / `created`                                                   | Pull-request reviews / `created`     | `payload.pull_request.number`, `payload.review.id`, canonical pull-request source URL                                                                                    | `payload.review.html_url`, `payload.review.state`; review body is never retained. `updated` and `dismissed` are unsupported. |
| `IssueCommentEvent` / `created`                                                        | Comments / `issue-comment`           | `payload.issue.number`, presence/absence of `payload.issue.pull_request` as the issue/PR discriminator, `payload.comment.id`, canonical issue or pull-request source URL | `payload.comment.html_url`, issue or pull-request title. Comment body is never retained.                                     |
| `PullRequestReviewCommentEvent` / `created`                                            | Comments / `review-comment`          | `payload.pull_request.number`, `payload.comment.id`, canonical pull-request source URL                                                                                   | `payload.comment.html_url`, `payload.comment.path`, `payload.comment.line`; comment body is never retained.                  |
| `CommitCommentEvent` / `created`                                                       | Comments / `commit-comment`          | `payload.comment.id`, `payload.comment.commit_id`, canonical repository identity                                                                                         | `payload.comment.html_url`, commit identity; comment body is never retained.                                                 |
| `DiscussionEvent` / `created`                                                          | Discussions / `created`              | `payload.discussion.number`, `payload.discussion.title`, `payload.discussion.html_url`                                                                                   | `payload.discussion.category`; discussion comments have no separate supported Events API mapping.                            |
| `ReleaseEvent` / `published`                                                           | Releases / `published`               | `payload.release.id`, `payload.release.tag_name`, `payload.release.html_url`                                                                                             | `payload.release.name`; release body is never retained. Other release actions are unsupported.                               |
| `ForkEvent` / `forked`                                                                 | Repository forks / `forked`          | canonical source repository identity, `payload.forkee.id`, `payload.forkee.full_name`, `payload.forkee.html_url`                                                         | Forked repository display name.                                                                                              |
| `CreateEvent` with `payload.ref_type === "branch"`                                     | Branches and tags / `branch-created` | `payload.ref`, `payload.ref_type`, canonical repository identity                                                                                                         | `payload.full_ref`. Repository creation is not a branch/tag activity.                                                        |
| `CreateEvent` with `payload.ref_type === "tag"`                                        | Branches and tags / `tag-created`    | `payload.ref`, `payload.ref_type`, canonical repository identity                                                                                                         | `payload.full_ref`.                                                                                                          |
| `DeleteEvent` with `payload.ref_type === "branch"`                                     | Branches and tags / `branch-deleted` | `payload.ref`, `payload.ref_type`, canonical repository identity                                                                                                         | `payload.full_ref` when present.                                                                                             |
| `DeleteEvent` with `payload.ref_type === "tag"`                                        | Branches and tags / `tag-deleted`    | `payload.ref`, `payload.ref_type`, canonical repository identity                                                                                                         | `payload.full_ref` when present.                                                                                             |

The supported event families and payload shapes are verified against the
[documented GitHub event types](https://docs.github.com/en/rest/using-the-rest-api/github-event-types?apiVersion=2026-03-10).

## Canonical source links

Source links are deterministic and must not be copied from arbitrary external
URLs. Use these rules:

- Pull-request and issue links are derived from the canonical repository name
  and object number: `https://github.com/{repo}/pull/{number}` or
  `https://github.com/{repo}/issues/{number}`.
- For `IssueCommentEvent`, a present `payload.issue.pull_request` selects the
  pull-request path; its absence selects the issue path. The discriminator is
  required even though the issue number is shared by both URL forms.
- Review, issue-comment, review-comment, and commit-comment links use the
  corresponding `payload.*.html_url` only after validating these exact forms:
  `/{repo}/pull/{number}#pullrequestreview-{review.id}`;
  `/{repo}/{issues|pull}/{number}#issuecomment-{comment.id}`;
  `/{repo}/pull/{number}#discussion_r{comment.id}`; and
  `/{repo}/commit/{comment.commit_id}#commitcomment-{comment.id}`. The
  validated URL is optional metadata if the provider does not supply it; its
  provider ID remains required for a comment or review mapping.
- Discussion and release links use `payload.discussion.html_url` and
  `payload.release.html_url`, validated respectively as
  `/{repo}/discussions/{discussion.number}` and
  `/{repo}/releases/tag/{release.tag_name}`.
- Fork links use `payload.forkee.html_url`, validated as
  `/{payload.forkee.full_name}`. The destination identity and URL are required
  for a `ForkEvent` mapping; the source repository remains the event's
  canonical repository identity.
- Push links use `/{repo}/commit/{payload.head}` when `payload.head` is a
  valid commit ID. Otherwise, a `refs/heads/{name}` or `refs/tags/{name}` ref
  uses `/{repo}/tree/{name}`; an unrecognized ref omits this optional link.
  Branch/tag create and delete mappings need only the canonical repository
  link because a deleted ref may no longer have a resolving page.

For every provider URL, require HTTPS, the exact host `github.com`, no
credentials or query string, and an exact repository/object path after URL
decoding. Locally derived links must percent-encode ref and tag components;
raw provider text must never be interpolated into a URL.

Before constructing any link, validate each repository identity as exactly two
non-empty slash-separated segments, with no backslash, extra slash, control
character, or segment equal to `.` or `..`. Encoded separators are invalid.
Validate numeric object IDs and issue/pull-request numbers as positive decimal
integers, commit IDs as 40-character hexadecimal strings, and refs/tags as
non-empty Git ref names without control characters, backslashes, `..`, or
`@{`. Percent-encode each ref or tag component before using it in a path.

An invalid or missing field required by these rules makes a supported mapping
invalid; it is not silently converted into an activity without a reliable
identity or source link.

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

## Canonical v0.2 activity serialization

The person-note contract supplies the entry envelope:

```text
- `{UTC timestamp}` — {activity fragment}
```

The activity fragment is exactly one of these forms. There is no alternate
wording, punctuation, field order, or link placement:

| Family        | Canonical activity fragment                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pushes        | `Push to [REPOSITORY](REPOSITORY_URL) at REF` when no source link is available, or `Push to [REPOSITORY](REPOSITORY_URL) at [REF](SOURCE_URL)` when one is available |
| Pull requests | `Pull request [#NUMBER](PULL_REQUEST_URL) ACTION in [REPOSITORY](REPOSITORY_URL): TITLE`                                                                             |
| Issues        | `Issue [#NUMBER](ISSUE_URL) ACTION in [REPOSITORY](REPOSITORY_URL): TITLE`                                                                                           |

`REPOSITORY` is the canonical `owner/name` identity and `REPOSITORY_URL` is
`https://github.com/{REPOSITORY}`. `ACTION` is the lowercase action in the
mapping table. `NUMBER` is the positive decimal object number. `TITLE` is the
required provider title after single-line normalization and Markdown escaping.
`REF` is the required validated push ref after the exact text-normalization
algorithm below. It is never rendered as an inline code span, so a valid ref
containing a backtick cannot terminate or alter the Markdown structure.

For a push, `REF` is rendered as a Markdown link when the optional canonical
commit or ref source link can be derived and validated; otherwise it is plain
escaped text. The display text remains the same in either case. Optional
branch, head, merge, and other metadata never changes the serialization and is
omitted when absent.

The exact provider-text normalization algorithm is:

1. Replace every ASCII control character, including carriage return, line feed,
   tab, and delete, with `U+FFFD`.
2. Replace Unicode line and paragraph separators (`U+2028` and `U+2029`) with
   `U+FFFD`.
3. Prefix a backslash to every ASCII punctuation character in the CommonMark
   escapable set, using the same fixed set for titles and refs. The set is
   exactly:

    ```text
    !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
    ```

The algorithm is applied once, in order, and never uses inline code formatting
for provider text. Repository identities and action words use their validated
canonical values. The complete entry is compared byte-for-byte after applying
the note's existing line-ending convention. No provider text may introduce a
link, marker, or additional Markdown structure.

## Pull-request and issue rules

Pull-request lifecycle actions are `opened`, `reopened`, `closed` without a
merge, and `merged`. Assignment, unassignment, labeling, and unlabeling do
not create standalone pull-request activity.

Issue lifecycle actions are `opened`, `reopened`, and `closed`. Assignment,
unassignment, labeling, and unlabeling do not create standalone issue
activity.

Repository stars and other events not explicitly listed in the mapping table
are outside this catalogue.

Future implementation tests must include a valid ref containing a backtick, a
backslash, Markdown punctuation, and ordinary branch names; titles containing
the same values; and ASCII control, newline, `U+2028`, and `U+2029` input. Each
vector must produce exactly one expected serialized line.

## Rendering boundary

Activity-specific factual fields are rendered through the person-note contract.
Provider text is untrusted and must be reduced to the smallest field-specific
single-line representation required by that contract. Markdown escaping,
marker containment, and validated source links are note-rendering concerns,
not reasons to retain raw provider payloads.
