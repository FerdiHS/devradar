# DevRadar Issue #2 + #3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the sample Obsidian plugin as DevRadar, remove all demo behavior, and leave a minimal bootstrap that is ready for the real MVP work.

**Architecture:** Keep identity changes separate from runtime cleanup so each step stays reviewable and the plugin remains buildable between commits. Keep `main.ts` focused on lifecycle wiring only, and keep settings persistence in `settings.ts` without creating speculative feature folders yet.

**Tech Stack:** TypeScript, Obsidian API, npm, esbuild, `manifest.json` / `versions.json` metadata.

## Global Constraints

- Plugin ID must be `devradar`.
- Display name must be `DevRadar`.
- Package name must be `devradar`.
- Initial development version must be `0.0.1`.
- Milestone 1 target version must be `0.1.0`.
- Minimum Obsidian version must be `1.0.0`.
- Author must be `FerdiHS`.
- Author URL must be `https://github.com/FerdiHS`.
- `isDesktopOnly` must remain `false`.
- The plugin must stay local-first and privacy-respecting.
- Do not add GitHub API access, auth, sync, telemetry, hosted services, or extra dependencies.
- Keep desktop and mobile compatibility in scope; avoid Node/Electron-only APIs.
- Keep `main.ts` small; do not create empty speculative folders or abstractions.
- Follow the updated GitHub issue descriptions for #2 and #3, not the old sample-template wording.

### Task 1: Rebrand metadata and durable identifiers

**Files:**
- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `versions.json`
- Modify: `README.md`
- Modify: `src/main.ts`
- Modify: `src/settings.ts`

**Interfaces:**
- Produces: `DevRadarPlugin` as the default export class name in `src/main.ts`
- Produces: `DevRadarSettings` as the persisted settings type in `src/settings.ts`
- Produces: `DevRadarSettingTab` as the settings tab class name in `src/settings.ts`

- [ ] Update `manifest.json` to the canonical DevRadar identity, including the `devradar` plugin ID, `DevRadar` display name, `0.0.1` version, `1.0.0` minimum app version, agreed description, `FerdiHS` author metadata, and no funding URL.
- [ ] Update `package.json` and `package-lock.json` so the package name and version agree with the manifest and the lockfile root metadata is no longer the sample plugin.
- [ ] Update `versions.json` to map `0.0.1` to `1.0.0`.
- [ ] Rename the long-lived TypeScript identifiers from `MyPlugin` / `MyPluginSettings` / `SampleSettingTab` to `DevRadarPlugin` / `DevRadarSettings` / `DevRadarSettingTab`, and update every import and reference.
- [ ] Rewrite `README.md` so it presents DevRadar as an early-development, local-first plugin for following selected GitHub users, not as an Obsidian sample plugin.
- [ ] If `package-lock.json` still differs after the metadata edits, run `npm install --package-lock-only` and recheck that the lockfile root metadata matches `package.json`.
- [ ] Run `npm run lint` and `npm run build` to confirm the metadata and rename pass do not break the project.
- [ ] Commit the identity-only change set with `git commit -m "chore: rebrand sample plugin as DevRadar"`.

### Task 2: Remove sample runtime behavior and placeholder settings

**Files:**
- Modify: `src/main.ts`
- Modify: `src/settings.ts`

**Interfaces:**
- Consumes: `DevRadarPlugin`, `DevRadarSettings`, and `DevRadarSettingTab` from Task 1
- Produces: a minimal plugin bootstrap with no sample commands, notices, modal, click handler, interval, or placeholder setting field

- [ ] Remove the sample ribbon icon, status bar item, commands, modal, click listener, interval logging, and any now-unused imports or comments from `src/main.ts`.
- [ ] Remove the placeholder `mySetting` field and the sample text input from `src/settings.ts`.
- [ ] Keep settings persistence and tab wiring, but make the tab minimal: it should explain that DevRadar has no configurable settings yet instead of showing sample controls.
- [ ] Keep `onload` / `onunload` and settings load/save behavior, but do not add any new feature scaffolding or empty folders.
- [ ] Run `npm run lint` and `npm run build` to catch leftover imports, dead code, or type drift.
- [ ] Manually load the built plugin in a test vault and confirm there is no sample notice, sample command, sample status bar item, sample modal, or placeholder setting.
- [ ] Commit the cleanup with `git commit -m "refactor: remove sample behavior from bootstrap"`.

## Test Plan

- `npm run lint` after each task to catch stale imports, renamed symbols, and dead code.
- `npm run build` after each task to ensure the plugin still bundles.
- `npm install --package-lock-only` only if the lockfile needs regeneration after the metadata rename.
- One final manual Obsidian smoke check after the runtime cleanup to confirm the sample UI is gone and the plugin still loads cleanly.

## Assumptions

- The updated issue bodies are the source of truth for #2 and #3.
- The “initial source structure” requirement is satisfied by keeping the repo minimal now and not creating empty `commands/`, `services/`, or `ui/` folders yet.
- `DevRadarSettings` can stay intentionally small for now; the real followed-person settings model remains out of scope until later MVP issues.
