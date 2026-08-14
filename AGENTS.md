# DevRadar agent guide

## Project summary

DevRadar is a local-first Obsidian Community Plugin for following selected GitHub users and recording supported public developer activity in Markdown notes.

## Canonical docs

- [Product direction](docs/product-direction.md)
- [MVP architecture](docs/architecture.md)
- [README](README.md)
- [Contributing](CONTRIBUTING.md)

## Repository map

- `src/main.ts`: plugin lifecycle and thin registration/wiring.
- `src/settings.ts`: settings types, defaults, and settings UI.
- `tests/`: unit tests and focused regressions.
- `package.json`: scripts, engines, dependencies, and hook config.
- `package-lock.json`: npm lockfile.
- `.husky/`: local Git hook entrypoints.
- `manifest.json` / `versions.json`: plugin metadata and release compatibility.
- `docs/`: product and design docs.
- `README.md` and `CONTRIBUTING.md`: public entry points for setup and workflow.

## Runtime data flow

Keep the codebase layered so the core stays testable without Obsidian:

The following progression describes runtime/data flow, not import or dependency
ownership. See the [MVP architecture](docs/architecture.md) for the normative
dependency direction and application-owned ports.

```text
domain logic
  -> application sync use cases
  -> GitHub and Obsidian adapters
  -> thin plugin and UI wiring
```

- Keep `src/main.ts` thin: lifecycle, composition/wiring, command registration,
  and settings/UI registration only; keep business and synchronization policy
  in application/domain code.
- Keep GitHub payload handling out of the domain layer.
- Put note writing and Obsidian API calls behind adapters.

## Durable rules

- Scope: keep changes issue-scoped and avoid unrelated refactors.
- Terminology: use follow, track, and developer activity language.
- Design: do not add empty folders or speculative abstractions.
- Note ownership: the user owns everything except the DevRadar-managed section.
- Note safety: preserve all user content outside DevRadar-managed sections; never automatically delete, rename, move, or overwrite whole notes; stop on missing, duplicated, malformed, or ambiguous markers.
- Obsidian APIs: use safe vault APIs for note operations.
- GitHub APIs: use documented GitHub REST APIs through `requestUrl()` for the unauthenticated MVP; do not use GraphQL, Octokit, scraping, or webhooks.
- Rate limits: respect GitHub rate-limit and retry headers; do not bypass them.
- History: do not promise exhaustive or real-time activity history.
- Partial failures: preserve successful updates when another followed person fails.
- Privacy: stay local-first, public-data-only, and free of telemetry or hosted infrastructure.
- Compatibility: avoid unnecessary Node.js, Electron, and desktop-only APIs; keep `isDesktopOnly` accurate.
- Dependencies: avoid unnecessary production dependencies.
- Testing: use sanitized fixtures rather than live GitHub requests in tests; add or update focused tests when behavior changes.
- Build hygiene: do not commit generated `main.js`.

## MVP boundary

The unauthenticated MVP must rely on `requestUrl()` plus GitHub REST endpoints only. Do not introduce authentication, GraphQL, Octokit, scraping, webhook flows, or hidden background collection unless the product direction and follow-up specs explicitly change.

## Pull requests

Pull requests must use a short Conventional Commit-style title; reserve `feat:` and `fix:` for shipped plugin behavior and use the pull-request body for issue-closing syntax.

## Completion rule

- Run `npm run check` before declaring work complete.
- Do not claim validation passed unless you actually ran the command and observed a successful result.
