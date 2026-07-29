# Contributing to DevRadar

DevRadar is a local-first Obsidian community plugin. Keep every change scoped, testable, and safe for both Obsidian Desktop and Mobile.

## Setup

Use a dedicated Obsidian test vault for all work. Do not use a personal vault or a production vault.
Do not commit the test vault, `.obsidian` configuration, workspace state, personal notes, or third-party plugin settings.

Prefer Node.js 24 LTS for local development. Node.js 22 is the minimum supported version, and npm is the package manager.

1. Create and open an empty Obsidian test vault.
2. Locate or create the `.obsidian/plugins/` folder inside that vault.
3. Clone or check out this repository directly into `<Test Vault>/.obsidian/plugins/devradar/`.
4. Run `npm install`.
5. Run `npm run build` and confirm that `main.js` exists in the plugin folder.
6. Open Obsidian Desktop, enable **DevRadar** under **Settings → Community plugins**, and then reload manually after rebuilds.

If you need a clean reinstall, use:

```bash
npm ci
```

During normal development, run:

```bash
npm run dev
```

Then reload Obsidian manually to pick up the rebuilt plugin.

## Desktop and mobile

- Use Obsidian Desktop for the normal development loop.
- Desktop testing does not prove mobile compatibility.
- Keep `isDesktopOnly` accurate.
- For user-facing changes, do a quick mobile smoke test when possible.

## Commands

- `npm install`: normal dependency setup
- `npm ci`: clean reinstall from the lockfile
- `npm run dev`: build in watch mode
- `npm run build`: type-check and build the production bundle
- `npm run format`: format the repository
- `npm run format:check`: check formatting only
- `npm run lint`: lint the codebase
- `npm run test`: run the test suite
- `npm run test:watch`: watch the test suite
- `npm run typecheck`: run TypeScript type checking
- `npm run check`: full validation for the repo

## Git hooks

Husky owns the local Git hooks for this repository.

- Normal `npm install` and `npm ci` install the hooks automatically.
- `pre-commit` runs `lint-staged` on staged files for formatting and lint fixes.
- `pre-push` runs `npm run test` and `npm run build`.
- `npm run prepare` restores the hooks after a fresh install or clean checkout.
- The hooks intentionally run a narrower set of checks to provide fast local feedback.
- They are optional local safeguards, not a replacement for `npm run check` or the required GitHub Actions checks.
- `npm run check` is still required before opening or updating a pull request.

## Workflow

- Start from an up-to-date `main` branch.
- Work on an issue-scoped branch.
- Keep changes small and focused.
- Add or update tests when behavior changes.
- Run `npm run check` before opening or updating a pull request.
- Use a Conventional Commit-style pull-request title.
- Expect normal pull requests to be squash merged.
- GitHub Actions uses the same canonical quality gate on pull requests and `main`.

Preserve user data and never overwrite vault content outside the plugin-managed area. Keep new code compatible with Obsidian Desktop and Mobile unless the feature is explicitly desktop-only. Update docs when workflow or setup changes.

## Troubleshooting

- Missing plugin: confirm the repository is checked out into `<Test Vault>/.obsidian/plugins/devradar/`, that **DevRadar** is enabled under **Settings → Community plugins**, and reload Obsidian.
- Missing `main.js`: run `npm run dev` or `npm run build` again, then reload Obsidian.
- Stale build output: rerun the build, then reload Obsidian manually.
- Broken dependency state: delete `node_modules/` and run `npm ci`.
