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

Use standalone HTML comments with no format-version attribute:

```md
<!-- devradar:begin github="octocat" -->

...
<!-- devradar:end github="octocat" -->
```

The marker username binds the section to one GitHub identity. Username
comparison is case-insensitive, so `OctoCat` and `octocat` identify the same
person. Casing may be rendered canonically without creating an ownership
conflict.

A writable associated note must contain exactly one well-formed, correctly
ordered, identity-matching pair. Fail closed without mutation for partial,
duplicated, nested, reversed, mismatched, malformed, foreign, or otherwise
ambiguous markers. Never infer boundaries from headings, blank lines, or
activity content, and never repair markers automatically.

### Marker grammar

Each marker is a complete line with exactly this grammar:

```text
<!-- devradar:begin github="USERNAME" -->
<!-- devradar:end github="USERNAME" -->
```

There is no leading or trailing whitespace, alternate quoting, extra
attribute, or extra token. `USERNAME` is the non-empty canonical GitHub login
returned by identity resolution. Marker comparison is case-insensitive for
the login, but the begin/end keyword and attribute name are exact. A line
matching either marker form inside the managed range is a nested or duplicate
marker and makes the note ambiguous; other HTML comments are ordinary note
content. Generated provider text must be escaped so it cannot create a marker
line.

## New-note template

A newly created person note contains only the required identity information and
the managed section:

```md
# octocat

GitHub: [@octocat](https://github.com/octocat)

<!-- devradar:begin github="octocat" -->

## DevRadar activity

_No activity recorded by DevRadar yet._
<!-- devradar:end github="octocat" -->
```

Do not copy display names, bios, avatars, locations, employment information,
or other profile metadata. After creation, the heading and profile line are
user-owned and are not maintained automatically.

## Managed presentation

The managed region contains the `## DevRadar activity` heading and one flat
Markdown list. Entries are newest-first and use the provider activity time in
UTC RFC 3339 form:

```md
- `2026-08-09T07:32:10Z` — <minimal factual activity with source link>
```

Do not group by date, repository, activity family, or inferred importance. Do
not place last-sync times, rate-limit state, completeness claims, retry data,
hidden provider IDs, or other operational metadata in the note.

Each entry uses the exact envelope and family-specific serialization defined by
[`activity.md`](activity.md). Implementations must not substitute equivalent
wording, reorder fields, or move links. The note's existing line-ending
convention is applied to the resulting Markdown, while the entry content itself
is compared byte-for-byte for canonical reconciliation.

## External text and links

GitHub-provided display text is untrusted. Before rendering it inside the
managed section:

- reduce it to a single line;
- remove or replace newline and control content;
- escape Markdown-significant characters for its exact output context;
- escape text that could otherwise create a marker line;
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
- One valid same-person section is reused; a second section is never appended.
- A foreign-person section rejects association without changing the note.
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

After computing the intended content, compare it with the current content. If
identical, perform no vault write. Re-rendering the same valid note and
normalized activity set must produce identical Markdown.

Any failure to establish one unambiguous managed range occurs before mutation.
The failed operation leaves the note unchanged and reports an actionable
person-specific error.

## Examples

An unmanaged existing note is initialized only at EOF:

```md
---
tags:
    - developer
---

# Notes about Octocat

Met at a conference.

<!-- devradar:begin github="octocat" -->

## DevRadar activity

_No activity recorded by DevRadar yet._
<!-- devradar:end github="octocat" -->
```

User content may surround a managed section:

```md
# octocat

My own observations remain outside the managed section.

<!-- devradar:begin github="octocat" -->

## DevRadar activity

- `2026-08-09T07:32:10Z` — <minimal factual activity with source link>
- `2026-08-08T16:04:22Z` — <minimal factual activity with source link>

<!-- devradar:end github="octocat" -->

More user-authored notes.
```

A section for `hubot` must not be associated automatically with `octocat`.
