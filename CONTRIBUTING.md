# Contributing to DevRadar

## Setup

- Use a dedicated Obsidian test vault for all work. Do not use a personal vault or a production vault.
- Do not commit the test vault, `.obsidian` configuration, workspace state, personal notes, or third-party plugin settings.
- Use Conventional Commit-style PR titles when opening pull requests.

Prefer Node.js 24 LTS for local development. Node.js 22 is the minimum supported version, and npm is the package manager.

1. Create and open an empty Obsidian test vault.
2. Locate or create the `.obsidian/plugins/` folder inside that vault.
3. Clone or check out this repository directly into `<Test Vault>/.obsidian/plugins/devradar/`.
4. Run `npm install`.
5. Run `npm run dev` and confirm that `main.js` appears in the plugin folder. Leave the watch build running during development.
6. Open Obsidian Desktop, enable **DevRadar** under **Settings → Community plugins**, and then reload manually after rebuilds.

If you need a clean reinstall from a clean working tree, use:

```bash
npm ci
```

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

## Release metadata

- `package.json.version` is the source of truth for release metadata.
- Run `npm run version:sync` to update `manifest.json` and `versions.json`.
- Run `npm run version:check` to verify that the release metadata still matches.
- Keep historical `versions.json` entries intact; only the current version entry should change.
- Release Please metadata is synchronized automatically by the trusted workflow.

### Initial Release Please bootstrap

Release Please normally creates or updates a release pull request when `main` receives a releasable Conventional Commit, such as:

- `feat:` for a shipped user-facing feature;
- `fix:` for a correction to shipped behaviour;
- a commit containing an intentional breaking-change marker.

Repository-only changes such as `docs:`, `test:`, `ci:`, `refactor:`, and `chore:` should retain their accurate type even when they do not trigger a release.

The initial `0.1.0` release pull request is bootstrapped once by adding this footer to the final squash commit body:

```text
Release-As: 0.1.0
```

The footer must appear in the resulting commit body on `main`. Adding it only to a pull-request description, review comment, or branch commit does not guarantee that it will be preserved by the final squash merge.

After the initial release pull request has been created, later versions should normally be determined from genuine releasable changes rather than forced with `Release-As:`.

Creating a Release Please pull request does not publish a release. The release is created only after the guarded release pull request is reviewed, approved, and merged.

## Pull requests

Use this title format:

```text
<type>(optional-scope): <summary>

feat: add followed GitHub users
fix(sync): preserve successful updates after a failure
docs: document release conventions
test: cover version synchronisation
ci: configure quality checks
refactor: simplify sync orchestration
chore(release): harden release automation
```

Types are lowercase, scopes are optional, summaries are concise and action-oriented, summaries have no trailing period, and issue numbers do not belong in titles. Reserve `feat:` and `fix:` for shipped plugin behavior; use `docs:`, `test:`, `ci:`, `refactor:`, `build:`, `chore:`, and `chore(release):` when shipped behavior is unchanged. Scopes do not override types. Using `!` or `BREAKING CHANGE` requires explicit discussion in the related issue.

Normal pull requests are squash-merged after all required checks pass. Verify the final squash subject uses the intended Conventional Commit type, correct it in GitHub's merge form when needed, and delete the merged branch.

Put `Closes #N` in the pull-request body, not the title; use `Related to #N` for additional issues that the pull request does not fully resolve. Classify mixed work by shipped behavior and split independent release meanings into separate pull requests.

### Release Please approval

1. Wait for version synchronisation.
2. Review the latest Release Please head.
3. Wait for all checks to pass.
4. Apply `release: ready` as `FerdiHS`.
5. Reapprove after any later head change.

Normal pull requests are unaffected. Approval is tied to the exact head, and failed validation or merging requires the label to be applied again.

## Git hooks

Husky owns the local Git hooks for this repository.

- Normal `npm install` and `npm ci` install the hooks automatically.
- `pre-commit` runs `lint-staged` on staged files for formatting and lint fixes.
- `pre-push` runs `npm run test && npm run build`.
- `npm run prepare` restores the hooks after a fresh install or clean checkout.
- The hooks intentionally run a narrower set of checks to provide fast local feedback.
- They are optional local safeguards, not a replacement for `npm run check` or the required GitHub Actions checks.

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
- Broken dependency state: from a clean working tree, run `npm ci` to recreate `node_modules/` from the lockfile.
