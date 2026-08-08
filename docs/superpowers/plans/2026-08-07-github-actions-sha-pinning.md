# GitHub Actions SHA Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve [Issue #30](https://github.com/FerdiHS/devradar/issues/30) by pinning every external workflow action invocation to a verified immutable commit without changing workflow behavior.

**Architecture:** Keep the workflows unchanged except for `jobs[*].steps[*].uses` references and same-line release-version comments. Add a test-only YAML inspection layer that parses workflow structure, validates job-step action invocations, and leaves reusable workflow references and local actions outside this check.

**Tech Stack:** GitHub Actions YAML, Node.js, Vitest, the `yaml` npm package, and the GitHub REST API/CLI.

## Global Constraints

- Pin external job-step actions to verified 40-character commit SHAs.
- Exclude local actions such as `./.github/actions/...`.
- Treat reusable workflow invocations separately.
- Preserve workflow permissions, triggers, checkout refs, release behavior, and safeguards.
- Do not enable GitHub Actions Dependabot in this issue; keep it as a follow-up recommendation.
- Do not publish a release solely to validate the pins.
- Record `sha_pinning_required` evidence in the implementation PR description.
- Run `npm run check` before completion.
- Do not commit generated `main.js`.

---

### Task 1: Add and apply schema-aware action pin validation

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release-please.yml`
- Modify: `.github/workflows/release-please-approval.yml`
- Modify: `.github/workflows/release-please-version-sync.yml`
- Create: `tests/workflows/action-pinning.test.ts`
- Modify: `tests/workflows/release-workflows.test.ts`

**Interfaces:**

<!-- prettier-ignore-start -->

- `tests/workflows/action-pinning.test.ts` provides test-local helpers:

    ```ts
    type ActionInvocation = {
        filePath: string;
        reference: string;
        line: number;
        comment: string;
    };

    function collectStepActionInvocations(
        source: string,
        filePath: string,
    ): ActionInvocation[];
    ```

<!-- prettier-ignore-end -->

- The helper parses YAML with `parseDocument` from `yaml`, traverses only
  `document.jobs[*].steps[*].uses`, ignores values beginning with `./`, and
  does not inspect `document.jobs[*].uses`.

- [ ] **Step 1: Add the direct YAML test dependency.**

    Run:

    ```bash
    npm install --save-dev yaml@^2.8.4
    ```

    Keep the dependency development-only. The package is already present
    transitively, but importing a transitive dependency directly would make the
    test contract brittle.

- [ ] **Step 2: Write the focused parser and validator tests.**

    Use an in-memory YAML fixture containing one external job-step action, one
    local action, and one reusable workflow:

    ```yaml
    jobs:
        external:
            steps:
                - uses: owner/action@0123456789012345678901234567890123456789 # v1.2.3
        local:
            steps:
                - uses: ./.github/actions/local
        reusable:
            uses: owner/repo/.github/workflows/reuse.yml@v1
    ```

    Assert that collection returns only the external job-step action. Add
    validation cases for:

    - a lowercase 40-character SHA with an exact `v1.2.3` comment;
    - a mutable tag such as `@v6`;
    - a branch reference;
    - an abbreviated SHA;
    - a missing or major-only version comment.

    Read each invocation's inline comment, trim it, and require the exact
    release-version shape `v<major>.<minor>.<patch>` when a release version is
    available. Resolve aliases only for their action value.

- [ ] **Step 3: Add dynamic validation for repository workflows.**

    Discover every `.yml` and `.yaml` file in `.github/workflows`, parse each
    file, collect its job-step action invocations, and assert that every
    discovered external action reference matches:

    ```regex
    ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$
    ```

    Do not hardcode the current four action names or scan every `uses:` line.
    This keeps local actions excluded and avoids rejecting reusable workflow
    references.

    Run the focused test at this point and confirm it fails against the current
    mutable workflow references. Do not commit a failing state.

- [ ] **Step 4: Resolve and verify the four upstream action pins.**

    Resolve the existing major tags from their upstream repositories:

    | Current reference                     | Upstream repository                |
    | ------------------------------------- | ---------------------------------- |
    | `actions/checkout@v6`                 | `actions/checkout`                 |
    | `actions/setup-node@v6`               | `actions/setup-node`               |
    | `actions/create-github-app-token@v3`  | `actions/create-github-app-token`  |
    | `googleapis/release-please-action@v5` | `googleapis/release-please-action` |

    For each action, resolve the major tag, dereference annotated tags, verify
    the resulting SHA through the same upstream repository, and identify the
    exact stable release represented by that commit. Do not upgrade to an
    unrelated release; pin the commit selected by the existing major tag.

    Record the action, exact release version, and SHA in the implementation PR
    description for review.

- [ ] **Step 5: Replace only the workflow action references.**

    Replace all 12 current invocations with the verified SHA and an exact
    same-line release comment, for example:

    ```yaml
    uses: actions/checkout@0123456789012345678901234567890123456789 # v6.1.0
    ```

    Use the same verified SHA and release comment for every occurrence of the
    same action. Do not alter adjacent `with:` blocks, permissions, triggers,
    conditions, checkout refs, tokens, or shell commands.

- [ ] **Step 6: Update the existing release contract assertion.**

    Remove the mutable literal `actions/create-github-app-token@v3` from
    `tests/workflows/release-workflows.test.ts`. The new focused action-pinning
    test owns the reference invariant; the existing test continues to own
    release-approval behavior and security safeguards.

- [ ] **Step 7: Run focused tests until green.**

    Run:

    ```bash
    npm run test -- tests/workflows/action-pinning.test.ts tests/workflows/release-workflows.test.ts
    ```

    Expected: all parser, scope, pin-format, release-comment, release-approval,
    and version-sync tests pass.

- [ ] **Step 8: Run final validation and audit the diff.**

    Query the repository Actions policy:

    ```bash
    gh api repos/FerdiHS/devradar/actions/permissions \\
      --jq '{enabled,allowed_actions,sha_pinning_required}'
    ```

    Record the returned `sha_pinning_required` value in the PR description. If
    access is unavailable, record the exact limitation instead of claiming that
    enforcement is enabled. Do not use the `protect-main` ruleset as evidence of
    this setting.

    Then run:

    ```bash
    git diff --check
    npm run check
    ```

    Inspect the final workflow diff and confirm it changes only action
    references/comments. Confirm permissions, triggers, job conditions,
    checkout refs, secrets, release commands, and generated files are unchanged.
    Do not publish a release solely for validation.

- [ ] **Step 9: Commit the complete atomic change.**

    Commit only after focused and full validation pass:

    ```bash
    git add package.json package-lock.json .github/workflows \\
      tests/workflows/action-pinning.test.ts \\
      tests/workflows/release-workflows.test.ts
    git commit -m "chore(ci): pin workflow actions to reviewed commits"
    ```

## Final acceptance

Issue #30 is resolved when:

- every external action invocation in `jobs[*].steps[*].uses` uses a reviewed
  full-length SHA;
- exact release-version comments are present where available;
- local actions and reusable workflows are handled separately;
- workflow behavior and security safeguards are unchanged;
- schema-aware workflow validation passes;
- focused workflow tests pass;
- `npm run check` passes;
- `sha_pinning_required` evidence is recorded in the PR description; and
- no release was published solely for validation.

## Explicitly excluded

Do not modify `.github/dependabot.yml` in this implementation. Enabling the
`github-actions` Dependabot ecosystem remains a separate recommendation.
