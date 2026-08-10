# Dependency security and maintenance

This repository uses npm development dependencies to type-check, lint, test,
and bundle DevRadar. The plugin runtime has no npm production dependencies;
`obsidian` is external to the generated bundle.

## Baseline review

Issue [#29](https://github.com/FerdiHS/devradar/issues/29) recorded the audit
snapshot from 2026-08-05. npm reported three high-severity package findings:
`brace-expansion`, `fast-uri`, and `js-yaml`. npm severity identifies an
advisory classification; it does not by itself establish exploitability in
the plugin runtime.

All affected packages were non-direct development dependencies and were not
included in `main.js`. The original dependency paths and decisions were:

| Package and original node                                                                                   | Complete dependency path                                                                                                                                                                                                                             | Decision                                 |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `brace-expansion@1.1.14` at `node_modules/brace-expansion`                                                  | `eslint@9.39.4` → `minimatch@3.1.5` → `brace-expansion`                                                                                                                                                                                              | Lockfile resolves to `1.1.18`.           |
| `brace-expansion@2.1.0` at `node_modules/eslint-plugin-json-schema-validator/node_modules/brace-expansion`  | `eslint-plugin-obsidianmd@0.4.0` → `eslint-plugin-json-schema-validator@5.1.0` → `minimatch@8.0.7` → `brace-expansion`                                                                                                                               | Lockfile resolves to `2.1.4`.            |
| `brace-expansion@2.1.0` at `node_modules/eslint-plugin-n/node_modules/brace-expansion`                      | `eslint-plugin-obsidianmd@0.4.0` → `@microsoft/eslint-plugin-sdl@1.1.0` → `eslint-plugin-n@17.10.3` → `minimatch@9.0.9` → `brace-expansion`                                                                                                          | Lockfile resolves to `2.1.4`.            |
| `brace-expansion@5.0.5` at `node_modules/@typescript-eslint/typescript-estree/node_modules/brace-expansion` | `typescript-eslint@8.59.2` → `@typescript-eslint/typescript-estree@8.59.2` → `minimatch@10.2.5` → `brace-expansion`                                                                                                                                  | Lockfile resolves to `5.0.9`.            |
| `fast-uri@3.1.2` at `node_modules/fast-uri`                                                                 | `eslint-plugin-obsidianmd@0.4.0` → `eslint-plugin-json-schema-validator@5.1.0` → `ajv@8.20.0` → `fast-uri`; `eslint-plugin-obsidianmd@0.4.0` → `eslint-plugin-json-schema-validator@5.1.0` → `json-schema-migrate@2.0.0` → `ajv@8.20.0` → `fast-uri` | Lockfile resolves to compatible `3.1.5`. |
| `js-yaml@4.1.1` at `node_modules/js-yaml`                                                                   | `eslint@9.39.4` → `@eslint/eslintrc@3.3.5` → `js-yaml`                                                                                                                                                                                               | Lockfile resolves to compatible `4.3.1`. |

The detailed advisory table below records every identifier from the baseline
audit, including severity, affected range, and selected patched version:

| Advisory                                                                 | npm severity | Affected range(s)                             | Patched version selected   |
| ------------------------------------------------------------------------ | ------------ | --------------------------------------------- | -------------------------- |
| [GHSA-jxxr-4gwj-5jf2](https://github.com/advisories/GHSA-jxxr-4gwj-5jf2) | moderate     | `>=5.0.0 <5.0.6`                              | `brace-expansion@5.0.9`    |
| [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) | high         | `<1.1.16`, `>=2.0.0 <2.1.2`, `>=3.0.0 <5.0.7` | `1.1.18`, `2.1.4`, `5.0.9` |
| [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | high         | `<1.1.17`, `>=2.0.0 <2.1.3`, `>=4.0.0 <5.0.8` | `1.1.18`, `2.1.4`, `5.0.9` |
| [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) | high         | `<1.1.18`, `>=2.0.0 <2.1.4`, `>=4.0.0 <5.0.9` | `1.1.18`, `2.1.4`, `5.0.9` |
| [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) | high         | `>=3.0.0 <=3.1.3`                             | `fast-uri@3.1.5`           |
| [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7) | high         | `>=3.0.0 <3.1.5`                              | `fast-uri@3.1.5`           |
| [GHSA-4c8g-83qw-93j6](https://github.com/advisories/GHSA-4c8g-83qw-93j6) | high         | `>=3.0.0 <3.1.3`                              | `fast-uri@3.1.5`           |
| [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68) | moderate     | `>=4.0.0 <=4.1.1`                             | `js-yaml@4.3.1`            |
| [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) | high         | `>=4.0.0 <4.3.0`                              | `js-yaml@4.3.1`            |

The selected versions remain within their parent dependency ranges. No
forced major upgrade or `npm audit fix` operation is used. If a later audit
reports a new finding, it requires the same path, compatibility, and bundle
review before remediation or exception approval.

## Issue #45 follow-up

The #45 follow-up confirmed that dependency audit results require path,
development-versus-runtime, bundle, compatibility, and remediation review. A
compatible development-tool repair should remain within the existing parent
range without a forced upgrade or `npm audit fix` operation.

Issue #45 re-evaluated and retained the documented TypeScript `>=7.0.0`
exception. Issue #45 does not require that migration and does not change issue
#57's scope.

## Obsidian development baseline

The direct `obsidian` development dependency is pinned to exact version
`1.13.1`. `eslint-plugin-obsidianmd@0.4.1` declares the regular dependency
`obsidian: "1.12.3"` and peer dependency `obsidian: "1.8.7"`, so npm resolves
the root project through `obsidian@1.13.1` and installs a nested
`eslint-plugin-obsidianmd/node_modules/obsidian@1.12.3` for the plugin's exact
regular dependency. This split is development-only and does not change plugin
runtime behavior because Obsidian remains external to the production bundle.

The development type-package version is separate from the runtime
`manifest.json` `minAppVersion`; new Obsidian API usage must be checked against
the declared runtime minimum, which must be raised when required.

`npm ls obsidian eslint-plugin-obsidianmd` exits successfully with the root
`obsidian@1.13.1` and nested plugin `obsidian@1.12.3`; `npm explain obsidian`
confirms both paths. The peer declaration remains `obsidian: "1.8.7"` and is
accepted as upstream metadata for this lint plugin. Future Obsidian or
lint-plugin updates must re-check both declarations rather than silently
inheriting this split.

## Lockfile authoring and repair baseline

The repository declares `npm@10.9.2` in `package.json` as metadata and tooling
input. Corepack can read the field when explicitly used, and other tooling may
use it for package-manager detection, but the field does not itself install or
enforce an npm binary and does not control Dependabot's hosted updater.
Corepack is not required by this repository policy.

Use Node.js `22.13.0` with npm `10.9.2` as the reviewed baseline when creating
or repairing `package-lock.json`. This is a dependency-state authoring
requirement, not a requirement for every ordinary development or quality
command. The current `main` lockfile is intentionally not regenerated by this
policy change: it installs successfully with npm `10.9.2` and npm `11`, and the
package-manager metadata is not represented in the lockfile root metadata.

For every dependency update that changes `package-lock.json`:

1. Inspect the exact bot head and the complete manifest/lockfile diff.
2. Reproduce `npm ci` with the supported Node.js matrix and record the
   effective Node.js and npm versions.
3. If the lockfile is malformed or incomplete, start from a clean `main`
   checkout and reproduce only the intended dependency update using Node.js
   22.13.0 and npm 10.9.2. For an update that changes `package.json`, apply
   only the intended manifest changes from the exact bot head. For a
   lockfile-only or transitive update, use the `main` manifest and reproduce
   the equivalent targeted dependency update without copying the malformed
   bot-generated lockfile. Regenerate `package-lock.json`, inspect the
   complete resulting manifest and lockfile diff, and rerun validation.
4. If the intended update cannot be reproduced safely without unrelated
   dependency changes, or otherwise cannot be repaired safely, prepare a
   reviewed human-owned replacement with a clear cross-reference. Do not close
   the bot pull request before the replacement is approved and exists; close
   or supersede it afterward while preserving the cross-reference.
5. Do not claim an unsupported Dependabot root cause. Record only evidence
   established by the exact-head reproduction and diff review.

A successful lockfile repair does not establish dependency compatibility;
independently review peer dependencies, engine requirements, and other
update-specific constraints.

The policy options considered were:

- A hard `npm audit` CI gate gives immediate enforcement, but registry
  outages, development-only findings, and false positives can block unrelated
  changes. npm severity is also a review signal, not proof of runtime
  exploitability.
- Dependabot alone provides update proposals but not the path, bundle, and
  compatibility review required for this plugin.
- Scheduled or manual review alone reduces automation but can delay awareness
  of newly published advisories.

## Ongoing maintenance policy

The selected combination is:

- Dependabot checks npm dependencies weekly through `.github/dependabot.yml`.
- Dependency update pull requests use the existing Node.js 22.13.0 and Node.js 24
  quality checks, including `npm ci`, version validation, tests, lint,
  formatting, type-checking, and build validation.
- Maintainers review dependency paths, direct versus development-only use,
  production-bundle inclusion, compatibility, and any residual risk.
- Run `npm audit --json` and `npm audit` when a security update is proposed,
  before a release, and at least quarterly.
- `npm audit` is a review input rather than a hard CI gate. Registry outages,
  development-only findings, and false positives must be recorded and
  reviewed rather than causing unconditional build failure.
- Do not use `npm audit fix --force`. Major upgrades require a separate
  compatibility decision.

## Temporary TypeScript 7+ security exception

The TypeScript 7+ rule in `.github/dependabot.yml` uses an ignored version
range because the repository must continue evaluating compatible TypeScript 6
updates while the current compiler, TypeScript ESLint stack, build, and
configuration remain incompatible with TypeScript 7. GitHub documents that
ignored versions apply to both version and security updates, so this rule also
temporarily prevents Dependabot from opening TypeScript 7+ security-update
pull requests.

This is a deliberate, narrow exception for the development-only TypeScript
toolchain, not evidence that TypeScript 7+ is safe to ignore indefinitely. The
exception was re-evaluated under issue [#45](https://github.com/FerdiHS/devradar/issues/45)
and remains temporarily accepted. Repository maintainers own this exception.
Revisit it when a compatible TypeScript 7+ migration is available, when a
TypeScript 7+ security advisory is published, or when the surrounding toolchain
or security coverage materially changes. Until then, maintainers must treat a
TypeScript 7+ advisory as an explicit manual review item rather than assuming
Dependabot will propose it automatically.

## Baseline validation

The reviewed npm baseline was validated from clean installs with npm `10.9.2`
on Node.js `22.14.0`. The issue #45 lockfile repair was authored and validated
with the exact Node.js `22.13.0` and npm `10.9.2` baseline, and local
validation also covered Node.js `24.x`; hosted CI remains the repository's
matrix validation for pull requests:

The repository minimum of Node.js `22.13.0` is intentional: the locked
development dependency `eslint-visitor-keys@5.0.1` supports Node.js 22 from
`22.13.0`, while `rolldown@1.1.5` requires at least `22.12.0`. The former is
the highest Node.js 22 floor imposed by the current toolchain, so CI tests
that exact minimum as well as Node.js `24.x`.

- `npm ci` completed successfully.
- `npm audit --json` reported zero vulnerabilities, and `npm audit` reported
  `found 0 vulnerabilities`.
- `npm ls brace-expansion fast-uri js-yaml --all` resolved only patched
  versions: `brace-expansion` `1.1.18`, `2.1.4`, and `5.0.9`; `fast-uri`
  `3.1.5`; and `js-yaml` `4.3.1`.
- `npm ls obsidian eslint-plugin-obsidianmd` and `npm explain obsidian`
  confirmed the documented Obsidian resolution and dependency paths.
- `npm run version:check` and `npm run check` passed.
- A separate `npm run build` followed by a search of `main.js` found no
  `brace-expansion`, `fast-uri`, `js-yaml`, `ajv`, `eslint`, or
  `typescript-eslint` package content; `obsidian` remained an external import.
  An esbuild metafile input inspection independently listed only
  `src/settings.ts` and `src/main.ts`, with no affected dependency inputs.

The CI matrix remains the validation source for Node.js `22.13.0` and
`24.x` compatibility.
