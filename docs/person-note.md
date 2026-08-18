# DevRadar person-note specification

This document resolves the person-note and managed-section contract for
[Issue #61](https://github.com/FerdiHS/devradar/issues/61). It defines the
Markdown contract only; it does not implement a parser, renderer, or Obsidian
vault adapter.

## Ownership

DevRadar owns only the content between its canonical managed-section markers.
Everything outside that range is user-owned, including headings, frontmatter,
profile links, observations, whitespace, and line endings.

DevRadar must preserve outside content exactly, must not overwrite an entire
existing note, and must never automatically delete, move, rename, or recreate
a note after it has been associated.

## Canonical markers

Use standalone HTML comments with no format-version attribute and with both
the canonical username and durable GitHub account ID:

```md
<!-- devradar:begin github="octocat" github-id="583231" -->

...
<!-- devradar:end github="octocat" github-id="583231" -->
```

The marker username and account ID together bind the section to one GitHub
identity. Username comparison is case-insensitive, so `OctoCat` and `octocat`
identify the same login; the positive decimal account ID must match exactly
after provider-ID normalization. A username match with a different account ID
is a foreign or ambiguous section and fails closed. A marker pair without
`github-id` is malformed under the v0.2.0 contract and is never auto-upgraded.
During ordinary managed-content replacement, valid existing marker lines are
ownership anchors and are preserved byte-for-byte, including their username
casing. Only newly rendered markers use the canonical username supplied for
the operation.

A writable associated note must contain exactly one well-formed, correctly
ordered, identity-matching pair. Fail closed without mutation for partial,
duplicated, nested, reversed, mismatched, malformed, foreign, or otherwise
ambiguous markers. Never infer boundaries from headings, blank lines, or
activity content, and never repair markers automatically.

### Marker grammar

Each marker is a complete line with exactly this grammar:

```text
<!-- devradar:begin github="USERNAME" github-id="GITHUB_ID" -->
<!-- devradar:end github="USERNAME" github-id="GITHUB_ID" -->
```

There is no leading or trailing whitespace, alternate quoting, extra
attribute, or extra token. `USERNAME` is the non-empty canonical GitHub login
returned by identity resolution. `GITHUB_ID` is the positive canonical
decimal account ID returned by identity resolution. Marker comparison is
case-insensitive for the login and exact for the account ID, while the
begin/end keywords and attribute names are exact and case-sensitive. A line
matching either marker form inside the managed range is a nested or duplicate
marker and makes the note ambiguous; other HTML comments are ordinary note
content. Any HTML comment whose trimmed body begins with `devradar:begin` or
`devradar:end` is a reserved DevRadar marker candidate; if it does not match
the exact grammar above, it is a malformed marker and the note fails closed.
Generated provider text must be escaped so it cannot create a marker line.

`USERNAME` must satisfy the canonical GitHub login grammar in
[`activity.md`](activity.md): 1–39 ASCII letters, digits, or hyphens, with no
leading, trailing, or consecutive hyphens. Never interpolate an unvalidated
username into a marker.

## New-note template

A newly created person note contains only the required identity information and
the managed section:

<!-- prettier-ignore -->
```md
# octocat

GitHub: [@octocat](https://github.com/octocat)

<!-- devradar:begin github="octocat" github-id="583231" -->
## DevRadar activity

_No activity recorded by DevRadar yet._
<!-- devradar:end github="octocat" github-id="583231" -->
```

Do not copy display names, bios, avatars, locations, employment information,
or other profile metadata. After creation, the heading and profile line are
user-owned and are not maintained automatically.

## Managed presentation

The managed region contains the `## DevRadar activity` heading and one flat
Markdown list. Entries are newest-first and use the provider activity time in
canonical UTC RFC 3339 form:

```md
- `2026-08-09T07:32:10Z` — <minimal factual activity with source link>
```

Sort entries by provider activity timestamp descending. For a newly rendered
set, equal timestamps sort by provider event ID ascending in lexicographic
string order. During a sync, retained canonical entries are sorted by provider
activity timestamp descending; within each equal-timestamp retained group,
their existing relative order is preserved. Newly added entries are inserted
by timestamp; when a new entry has the same timestamp as retained entries,
place it after the retained group, and order multiple new entries by provider
event ID ascending. These ordering keys are internal and are never rendered in
the note.

Normalize each valid provider ISO-8601 timestamp by parsing its instant,
converting it to UTC, and emitting `YYYY-MM-DDTHH:mm:ssZ` when the instant has
no fractional second. When it has a fractional second, emit the same form with
`.` followed by the significant fractional digits and a trailing `Z`; remove
trailing fractional zeroes and never round. Thus offset forms, `.100Z`, and
`.1Z` for the same instant serialize identically, while sub-second precision is
preserved. Invalid timestamps are required mapping data and fail the person's
sync.

Do not group by date, repository, activity family, or inferred importance. Do
not place last-sync times, rate-limit state, completeness claims, retry data,
hidden provider event IDs, per-entry payload metadata, or other operational
metadata in the note. The managed-section `github-id` is required section-level
identity metadata and is allowed; it is not an event ID or sync state.

Each entry uses the exact envelope and family-specific serialization defined by
[`activity.md`](activity.md). Implementations must not substitute equivalent
wording, reorder fields, or move links. The note's existing line-ending
convention is applied to the resulting Markdown, while the entry content itself
is compared byte-for-byte for canonical reconciliation.

## External text and links

GitHub-provided display text is untrusted. Before rendering it inside the
managed section:

- apply the exact single-line normalization and ASCII punctuation escaping
  algorithm in [`activity.md`](activity.md);
- derive links from validated canonical GitHub identifiers or accept only URLs
  that are absolute HTTPS URLs on `github.com`, contain no credentials, and
  match the expected repository/object path from the activity contract;
- keep all output inside the identified managed range.

Use the smallest field-specific rules required by the canonical output. Do not
create a generic fuzzy sanitization layer.

## Association lifecycle

Inspect the note before changing it.

- A marker-free existing note may receive one managed section at EOF during
  explicit initial association.
- EOF initialization preserves every existing byte. Choose the first existing
  line-ending sequence (`CRLF`, `LF`, or `CR`), or `LF` when the note has none;
  append the minimum number of that sequence needed for the bytes immediately
  before the new section to end with two consecutive line endings, then append
  the canonical managed section. The first sequence is selected by scanning
  left-to-right, treating `CRLF` as one sequence; this same rule applies to all
  generated managed content in mixed-line-ending notes. Existing trailing
  whitespace is never removed.
- One valid same-person section whose username and account ID both match is
  reused; a second section is never appended.
- A foreign-person section rejects association without changing the note.
- A username-only or account-ID-mismatched section rejects association without
  automatic migration or mutation.
- After association, missing markers are an error rather than permission to
  recreate the section.
- A missing associated note causes person-scoped sync failure rather than
  automatic recreation.
- Users may edit content inside a valid managed section, but DevRadar may
  regenerate the entire managed content later.

Changing a configured note path is an explicit reassociation governed by the
settings contract. It does not move or migrate the old note.

## Preservation and idempotence

When updating an existing note, modify only the managed range and preserve all
outside bytes and the existing line-ending convention. Newly created notes may
use `\n` line endings.

A standalone generated managed section ends at the final `>` of its end marker;
it owns no trailing line ending after that marker. The line ending immediately
before an end marker is part of the generated managed content, while the marker
text itself remains an exact preserved anchor when replacing an existing note.

After computing the intended content, compare it with the current content. If
identical, perform no vault write. Re-rendering the same valid note and
normalized activity set must produce identical Markdown.

Any failure to establish one unambiguous managed range occurs before mutation.
The failed operation leaves the note unchanged and reports an actionable
person-specific error.

Future implementation tests must cover EOF initialization for content ending in
zero, one, and multiple line endings, trailing spaces, and each supported line-
ending convention. The resulting note must preserve the original prefix
byte-for-byte and contain at least the required blank-line separation.

## Examples

An unmanaged existing note is initialized only at EOF:

<!-- prettier-ignore -->
```md
---
tags:
    - developer
---

# Notes about Octocat

Met at a conference.

<!-- devradar:begin github="octocat" github-id="583231" -->
## DevRadar activity

_No activity recorded by DevRadar yet._
<!-- devradar:end github="octocat" github-id="583231" -->
```

User content may surround a managed section:

<!-- prettier-ignore -->
```md
# octocat

My own observations remain outside the managed section.

<!-- devradar:begin github="octocat" github-id="583231" -->
## DevRadar activity

- `2026-08-09T07:32:10Z` — <minimal factual activity with source link>
- `2026-08-08T16:04:22Z` — <minimal factual activity with source link>
<!-- devradar:end github="octocat" github-id="583231" -->

More user-authored notes.
```

A section for `hubot` must not be associated automatically with `octocat`.
