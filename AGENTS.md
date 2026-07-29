# DevRadar agent guide

## Project summary

DevRadar is a local-first Obsidian Community Plugin for following selected GitHub users and recording supported public activity in Markdown notes.

## Canonical docs

- [Product direction](docs/product-direction.md)
- [README](README.md)
- [Contributing](CONTRIBUTING.md)

## Dependency direction

Keep the codebase layered so the core stays testable without Obsidian:

```text
domain logic
  -> application sync use cases
  -> GitHub and Obsidian adapters
  -> thin plugin and UI wiring
```

- Keep `src/main.ts` lifecycle-only.
- Keep GitHub payload handling out of the domain layer.
- Put note writing and Obsidian API calls behind adapters.

## Durable rules

- Note ownership: the user owns everything except the DevRadar-managed section.
- Marker safety: only edit the managed section; stop on missing, duplicated, malformed, or ambiguous markers.
- API usage: use documented GitHub REST APIs through `requestUrl()` for the unauthenticated MVP; do not use GraphQL, Octokit, scraping, or webhooks.
- Privacy: stay local-first, avoid telemetry, and never move vault data outside the plugin-managed flow.
- Compatibility: keep the default experience working on Obsidian Desktop and Mobile; avoid desktop-only APIs unless the feature is explicitly desktop-only.
- Testing: add or update tests when behavior changes, and run the repo checks before declaring work complete.

## MVP boundary

The unauthenticated MVP must rely on `requestUrl()` plus GitHub REST endpoints only. Do not introduce authentication, GraphQL, Octokit, scraping, webhook flows, or hidden background collection unless the product direction and follow-up specs explicitly change.

## Pull requests

Use a short Conventional Commit-style pull-request title, such as `feat: ...` or `fix: ...`.

## Completion rule

Do not declare work complete until `npm run check` passes.
