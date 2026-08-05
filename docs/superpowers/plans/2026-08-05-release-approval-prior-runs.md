# Release Please Prior Approval Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow retries of the same verified Release Please approval workflow for one exact pull-request head without treating earlier suites from that workflow as external failures, while continuing to gate on every unrelated check and status.

**Architecture:** The trusted base workflow will retrieve the current run by `github.run_id`, then list all runs of that exact workflow ID for the approved head SHA and `pull_request_target` event with REST pagination. The Node policy will validate the current run and every candidate run against repository, workflow ID/path, event, head SHA, and integer check-suite identity, build the trusted suite-ID set, and filter check runs by those IDs before name deduplication. Initial evaluation and final pre-merge revalidation will pass the same metadata shape to the same policy.

**Tech Stack:** GitHub Actions YAML, `gh api`, `jq`, Node.js 22/24-compatible ECMAScript module, Vitest, sanitized shell fixtures.

## Global Constraints

- Keep trusted-base execution through `pull_request_target` and the base SHA checkout.
- Keep the exact Release Please repository, branch, author, marker, draft, base, actor, and head checks.
- Keep fresh pull-request, check-run, status, workflow-run, and exact-head merge validation immediately before merging.
- Treat malformed, missing, ambiguous, or unverified workflow ownership as rejection or operational failure; never fail open.
- Identify trusted checks through verified workflow-run/check-suite metadata, never a check name, app name, or URL alone.
- Keep Node.js 22.x and Node.js 24.x quality checks explicitly required.
- Preserve label cleanup, concise rejection comments, invalidation, operational-failure distinction, no force merge, no force push, and no alternate-head retry.
- Do not modify, label, approve, rerun, merge, close, branch-update, tag, release, or otherwise mutate Release Please PR #22.
- Use only the existing `actions: read` permission for the new workflow-run read; do not add write permissions.
- Do not create a PR; commit and push only `fix/release-approval-prior-runs`.

## Confirmed Root Cause

Read-only GitHub metadata confirms the reopened issue comment:

- PR #22 still points at head `5c567fd56e737bbe6a422cd379a886f49f2c2019`.
- The approval workflow is workflow ID `325110255`, path `.github/workflows/release-please-approval.yml`, event `pull_request_target`, repository `FerdiHS/devradar`.
- Four approval workflow runs for that exact head produced suites `83594762364`, `83595033611`, `83623424226`, and `83875119926`.
- Run `30829236488` rejected with `Check run Apply Release Please approval decision must complete successfully.` because the earlier suite `83594762364` remained in the head’s check-run list after PR #27 excluded only current suite `83595033611`.
- The earlier check was the same trusted workflow’s `Apply Release Please approval decision` job, not another workflow, repository, or app. The API shows the checks under GitHub Actions app ID `15368` and the corresponding workflow runs under the same repository/workflow/event/head identity.
- PR #27 moved filtering before name deduplication, which fixed same-name hiding for one suite but could not recognize historical suites from later approval attempts.

## Trusted Identity Invariants

The policy input will contain:

```js
{
  currentWorkflowRun: { id, workflow_id, path, name, event, head_sha, check_suite_id, repository: { full_name } },
  workflowRuns: [{ id, workflow_id, path, name, event, head_sha, check_suite_id, repository: { full_name } }],
  checkRuns: [{ name, status, conclusion, created_at, started_at, completed_at, check_suite: { id }, app }],
  statuses: [...]
}
```

The helper that builds trusted suite IDs will:

1. Require safe non-negative integer IDs for the current run ID, workflow ID, current suite ID, and every returned run ID, workflow ID, and suite ID.
2. Require the current run and each candidate run to have the exact trusted repository `repository`, workflow path `.github/workflows/release-please-approval.yml`, workflow name `Release Please approval`, event `pull_request_target`, and approved `headSha`.
3. Require the current run to be represented in the paginated candidate run list with the same run ID, workflow ID, head SHA, event, repository, and suite ID.
4. Ignore well-formed runs for another repository, head SHA, event, or workflow identity as ownership evidence; their suites cannot enter the trusted set and their check runs remain external.
5. Reject if a returned run is structurally malformed or the exact current run is absent, because incomplete workflow ownership cannot safely classify checks.
6. Require every check run to have a safe nested `check_suite.id`; filter only if that ID is in the validated trusted suite-ID set, then deduplicate all remaining checks by name and validate their latest status/conclusion.
7. Never use check names, app identity, or details URLs as the trusted-workflow test. A same-name check from another suite or app remains external.

## GitHub API Calls and Pagination

Both workflow phases will use the same sequence and data shape:

```text
GET /repos/${REPOSITORY}/actions/runs/${GITHUB_RUN_ID}
GET /repos/${REPOSITORY}/actions/workflows/${WORKFLOW_ID}/runs?head_sha=${HEAD_SHA}&event=pull_request_target&per_page=100
GET /repos/${REPOSITORY}/commits/${HEAD_SHA}/check-runs?per_page=100
GET /repos/${REPOSITORY}/commits/${HEAD_SHA}/statuses?per_page=100
```

The workflow-run list uses `gh api --paginate --slurp` and flattens every page’s `.workflow_runs[]`; check runs and statuses retain their existing pagination. Any endpoint, JSON, pagination, or identity failure is an operational failure in the shell phase. The documented fine-grained permission for listing workflow runs is Actions read, already present in `.github/workflows/release-please-approval.yml`; no permission change is planned.

## Task 1: Add failing policy regressions

**Files:**

- Modify: `tests/workflows/release-workflows.test.ts`
- Reference: `.github/scripts/release-please-approval.mjs`

**Interfaces:**

- Consumes: the existing `evaluateReleaseApproval` test boundary.
- Produces: literal fixtures for current and historical workflow identities, trusted suites, external same-name checks, malformed metadata, wrong-head/event/repository runs, and paginated-run behavior.

- [x] **Step 1: Extend the test input types and valid fixture with a current run plus multiple workflow runs.** Use suite IDs `123`, `124`, and `125`, repository `FerdiHS/devradar`, path `.github/workflows/release-please-approval.yml`, name `Release Please approval`, event `pull_request_target`, and head `0123456789abcdef`.
- [x] **Step 2: Add the failing historical-run test.** The literal fixture must include current suite `123`, earlier suite `124`, and another earlier suite `125`; add pending `Apply Release Please approval decision` runs from suites `124` and `125`, then assert `{ decision: 'approve' }`. This fails against the current one-suite policy because the earlier runs are treated as external.
- [x] **Step 3: Add failing protection tests before implementation.** Assert rejection for a pending same-name run with a different workflow ID/path, a different app, another head SHA, another event, and another repository; assert rejection for failed/pending external checks and failed statuses; assert approval with successful Node 22/24 checks plus all trusted historical suites.
- [x] **Step 4: Add failing identity tests.** Assert rejection for missing current workflow identity, malformed current workflow ID, malformed current suite ID, malformed historical workflow ID, malformed historical suite ID, and an exact current run missing from the returned run list.
- [x] **Step 5: Add a failing pagination-shaped test.** Provide more than one trusted historical run page as a flattened array and assert all trusted suites are excluded; add the workflow shell contract assertion that the workflow-run list call contains `--paginate --slurp` and `per_page=100`.
- [x] **Step 6: Run the focused policy test file and confirm RED.** Run `npm run test -- tests/workflows/release-workflows.test.ts`. Expected: the new historical-run approval test and identity/API contract assertions fail because production still accepts only `currentCheckSuiteId`.

## Task 2: Implement shared trusted-suite ownership and initial evaluation

**Files:**

- Modify: `.github/scripts/release-please-approval.mjs`
- Modify: `.github/workflows/release-please-approval.yml`
- Test: `tests/workflows/release-workflows.test.ts`

**Interfaces:**

- Consumes: Task 1’s `currentWorkflowRun`, `workflowRuns`, `checkRuns`, and `statuses` fixtures.
- Produces: `evaluateReleaseApproval(input)` that validates workflow ownership and excludes every suite in the verified set before latest-name selection; initial shell input with fresh current run and paginated exact-workflow runs.

- [x] **Step 1: Implement the smallest identity helpers.** Add `isValidId`, `isWorkflowRunShape`, and `trustedCheckSuiteIds` in the policy module. Return `undefined` for malformed current identity, malformed returned run objects, missing exact current run, wrong trusted path/name/event/repository/head, or an empty matching set.
- [x] **Step 2: Replace the single-suite input with the validated trusted suite set.** Validate every check run’s nested suite ID, filter `checkRuns` using `trustedSuiteIds.has(checkRun.check_suite.id)`, then run the existing latest-by-name and external success checks. Keep required CI names and status handling unchanged.
- [x] **Step 3: Update the initial workflow shell.** After fetching `GITHUB_RUN_ID`, extract and validate the integer workflow ID, call the exact workflow ID runs endpoint with `head_sha`, `event`, `per_page=100`, `--paginate`, and `--slurp`, then pass `currentWorkflowRun` and flattened `workflowRuns` to Node. Preserve existing API-failure output distinction.
- [x] **Step 4: Run the focused tests and confirm GREEN.** Run `npm run test -- tests/workflows/release-workflows.test.ts`. Expected: policy tests, initial evaluation fixtures, failed/pending external checks, same-name spoof checks, and malformed identity tests pass.
- [x] **Step 5: Refactor only after green.** Remove obsolete `currentCheckSuiteId` fields and update names/messages without changing behavior; rerun the focused test file.

## Task 3: Apply the same ownership rule to final revalidation

**Files:**

- Modify: `.github/workflows/release-please-approval.yml`
- Test: `tests/workflows/release-workflows.test.ts`

**Interfaces:**

- Consumes: the shared policy contract from Task 2.
- Produces: final mutation revalidation that fetches fresh PR state, checks, statuses, current workflow run, and all exact-workflow runs before exact-head merge.

- [x] **Step 1: Add failing shell scenarios for historical suites in final revalidation.** Make the fake `gh` return a current suite plus multiple prior trusted suites and pending approval job checks; assert the mutation reaches the exact-head merge. Make same-name checks with an untrusted suite or app fail closed and assert label removal/comment with no merge.
- [x] **Step 2: Update the mutation shell.** After fresh PR/check/status reads, retrieve `GITHUB_RUN_ID`’s current run with the read token, derive its workflow ID, list the same workflow for the exact head/event with pagination, and pass both metadata objects to Node. Do not use the mutation job’s displayed name or app identity as the exclusion rule.
- [x] **Step 3: Run the focused shell tests and confirm GREEN.** Run `npm run test -- tests/workflows/release-workflows.test.ts`. Expected: initial and final historical-suite tests pass, current evaluation/mutation self-check tests pass, external failures still reject, and operational failures still clean up.
- [x] **Step 4: Verify equivalent inputs.** Compare the JSON object construction in both workflow phases and keep field names and policy invocation equivalent; retain fresh exact-head PR validation and `-f sha="${HEAD_SHA}"` merge protection.

## Task 4: Full validation and review

**Files:**

- Review: `.github/workflows/release-please-approval.yml`
- Review: `.github/scripts/release-please-approval.mjs`
- Review: `tests/workflows/release-workflows.test.ts`
- Review: `docs/superpowers/plans/2026-08-05-release-approval-prior-runs.md`

- [x] **Step 1: Run focused validation.** Run `npm run test -- tests/workflows/release-workflows.test.ts`, `npm run version:check`, and inspect `git diff --check`.
- [x] **Step 2: Run full validation.** Run `npm run test`, `npm run version:check`, and `npm run check`; record exit status and observed pass counts.
- [x] **Step 3: Inspect the final diff against `origin/main`.** Confirm only the plan, workflow, policy, and focused test files changed; no `main.js`, version metadata, tags, releases, or PR #22 branch changes exist.
- [x] **Step 4: Request independent review.** Review the diff for workflow-identity spoofing, pagination completeness, stale/wrong-head/wrong-event data, app/repository confusion, initial/final divergence, fail-open API behavior, permissions, unrelated checks, and exact-head races. Resolve every valid Critical or Important finding, rerun full validation, and re-review the final diff. The independent review found one Important shell-shape issue; the workflow now rejects unsafe current IDs and malformed paginated envelopes operationally. Final re-review found no Critical or Important findings.
- [x] **Step 5: Commit and push only after fresh verification.** Use focused Conventional Commits, including `fix(release): handle prior approval workflow runs` for shipped behavior, then push `fix/release-approval-prior-runs` with `git push -u origin fix/release-approval-prior-runs`. Do not run `gh pr create` and do not mutate PR #22 or Issue #26.

## Completion Checklist

- [x] Root cause is reported with the observed run, check, suite, repository, app, event, and head metadata.
- [x] Current and historical trusted workflow suites are excluded only after exact identity validation.
- [x] Same-name unrelated workflow/app checks remain external and block when pending or failed.
- [x] Other head/event/repository runs cannot supply ownership evidence.
- [x] Node 22 and Node 24 checks remain explicit required checks.
- [x] Initial evaluation and final revalidation use equivalent fresh ownership inputs.
- [x] Pagination, operational failure, cleanup, invalidation, exact-head merge, and security protections remain covered.
- [x] `npm run check` and all requested validation commands have fresh successful output before any success claim.
- [x] Independent review findings and commit SHAs are reported; PR creation is left to the maintainer.
