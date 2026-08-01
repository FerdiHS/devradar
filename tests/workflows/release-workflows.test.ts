import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The trusted workflow helper intentionally has no TypeScript declaration.
import { evaluateReleaseApproval as importedEvaluateReleaseApproval } from '../../.github/scripts/release-please-approval.mjs';

type CheckRun = {
	name: string;
	status: string;
	conclusion: string | null;
	completed_at?: string;
	started_at?: string;
};

type CommitStatus = {
	context: string;
	state: string;
	created_at?: string;
	updated_at?: string;
};

type ApprovalInput = {
	action: string;
	labelName: string;
	actorLogin: string;
	repository: string;
	baseRef: string;
	headRepository: string;
	headRef: string;
	headSha: string;
	authorLogin: string;
	draft: boolean;
	body: string;
	releasePleaseAppSlug: string;
	checkRuns: CheckRun[];
	statuses: CommitStatus[];
};

type ApprovalDecision = {
	decision: string;
	reason?: string;
};

type EvaluateReleaseApproval = (input: ApprovalInput) => ApprovalDecision;

type ApprovalShellFixture = {
	callsPath: string;
	directory: string;
	eventPath: string;
	outputPath: string;
	path: string;
	scenario: string;
};

const evaluateReleaseApproval =
	importedEvaluateReleaseApproval as EvaluateReleaseApproval;

const repositoryRoot = process.cwd();
const versionSyncWorkflow = readFileSync(
	join(repositoryRoot, '.github/workflows/release-please-version-sync.yml'),
	'utf8',
);
const approvalWorkflow = readFileSync(
	join(repositoryRoot, '.github/workflows/release-please-approval.yml'),
	'utf8',
);
const approvalPolicy = readFileSync(
	join(repositoryRoot, '.github/scripts/release-please-approval.mjs'),
	'utf8',
);

function extractRunStep(workflow: string, stepName: string) {
	const lines = workflow.split('\n');
	const nameIndex = lines.findIndex(
		(line) => line.trim() === `- name: ${stepName}`,
	);

	if (nameIndex === -1) {
		throw new Error(`Workflow step not found: ${stepName}`);
	}

	let runIndex = nameIndex + 1;
	while (runIndex < lines.length) {
		const line = lines[runIndex];
		if (line !== undefined && /^\s*run: \|$/.test(line)) {
			break;
		}
		runIndex += 1;
	}

	const runLine = lines[runIndex];
	if (runLine === undefined) {
		throw new Error(`Run block not found for: ${stepName}`);
	}

	const runIndent = runLine.match(/^\s*/)?.[0].length ?? 0;
	const indentedBody: string[] = [];

	for (let index = runIndex + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined) {
			continue;
		}
		const indent = line.match(/^\s*/)?.[0].length ?? 0;

		if (line.length > 0 && indent <= runIndent) {
			break;
		}

		indentedBody.push(line);
	}

	const bodyIndent =
		indentedBody.find((line) => line.trim().length > 0)?.match(/^\s*/)?.[0]
			.length ?? 0;

	return indentedBody
		.map((line) => line.slice(Math.min(bodyIndent, line.length)))
		.join('\n')
		.trimEnd();
}

function runBash(
	script: string,
	cwd: string,
	env: Record<string, string | undefined> = {},
) {
	return execFileSync('/bin/bash', ['-euo', 'pipefail', '-c', script], {
		cwd,
		env: { ...process.env, ...env },
		encoding: 'utf8',
		stdio: 'pipe',
	});
}

function git(cwd: string, args: string[]) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: 'pipe',
	}).trim();
}

function readWorkflowOutputs(path: string) {
	const outputs = Object.fromEntries(
		readFileSync(path, 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const separator = line.indexOf('=');
				return [line.slice(0, separator), line.slice(separator + 1)];
			}),
	);

	return {
		decision: outputs.decision ?? '',
		operational_failure: outputs.operational_failure ?? '',
		reason: outputs.reason ?? '',
	};
}

function createApprovalShellFixture(scenario: string) {
	const directory = mkdtempSync(
		join(tmpdir(), 'devradar-approval-workflow-'),
	);
	const binDirectory = join(directory, 'bin');
	const callsPath = join(directory, 'gh-calls.log');
	const eventPath = join(directory, 'event.json');
	const outputPath = join(directory, 'output.txt');
	const ghPath = join(binDirectory, 'gh');

	mkdirSync(binDirectory);
	writeFileSync(
		ghPath,
		`#!/bin/bash
set -euo pipefail

printf '%s\\n' "$*" >> "$GH_CALLS"

case "$*" in
  *check-runs*)
    if [ "$GH_SCENARIO" = 'check-api-failure' ]; then
      echo 'HTTP 503' >&2
      exit 1
    fi
    if [ "$GH_SCENARIO" = 'current-check-failure' ]; then
      printf '%s\\n' '[{"check_runs":[{"name":"Quality checks - Node.js 22.x","status":"completed","conclusion":"failure","completed_at":"2026-07-31T01:00:00Z"},{"name":"Quality checks - Node.js 24.x","status":"completed","conclusion":"success","completed_at":"2026-07-31T01:00:00Z"}]}]'
      exit 0
    fi
    printf '%s\\n' '[{"check_runs":[{"name":"Quality checks - Node.js 22.x","status":"completed","conclusion":"success","completed_at":"2026-07-31T00:00:00Z"},{"name":"Quality checks - Node.js 24.x","status":"completed","conclusion":"success","completed_at":"2026-07-31T00:00:00Z"}]}]'
    ;;
  *statuses*)
    if [ "$GH_SCENARIO" = 'status-api-failure' ]; then
      echo 'HTTP 503' >&2
      exit 1
    fi
    if [ "$GH_SCENARIO" = 'current-status-failure' ]; then
      printf '%s\\n' '[[{"context":"external-check","state":"failure","updated_at":"2026-07-31T01:00:00Z"}]]'
      exit 0
    fi
	    printf '%s\\n' '[[{"context":"external-check","state":"success","updated_at":"2026-07-31T00:00:00Z"}]]'
    ;;
  *'/merge'*)
    case "$GH_SCENARIO" in
      stale-head)
        echo 'HTTP 409' >&2
        exit 1
        ;;
      merge-api-failure)
        echo 'HTTP 500' >&2
        exit 1
        ;;
    esac
    printf '%s\\n' '{"merged":true}'
    ;;
  *'/pulls/'*)
    state='open'
    draft='false'
    base_ref='main'
    head_sha='head-sha'
    updated_at='2026-07-31T00:00:00Z'
    labels='[{"name":"release: ready"}]'
    case "$GH_SCENARIO" in
      current-base-changed)
        base_ref='release'
        ;;
      current-label-removed)
        labels='[]'
        ;;
      current-reopened)
        updated_at='2026-07-31T01:00:00Z'
        ;;
      current-draft)
        draft='true'
        ;;
      current-head-changed)
        head_sha='new-head-sha'
        ;;
    esac
    printf '%s\\n' '{"state":"'"$state"'","draft":'"$draft"',"base":{"ref":"'"$base_ref"'"},"head":{"repo":{"full_name":"FerdiHS/devradar"},"ref":"release-please--branches--main--components--devradar","sha":"'"$head_sha"'"},"user":{"login":"release-please[bot]"},"body":"This PR was generated with Release Please.","updated_at":"'"$updated_at"'","labels":'"$labels"'}'
    ;;
  *'/labels/'*)
    if [ "$GH_SCENARIO" = 'missing-label' ]; then
      echo 'HTTP 404' >&2
      exit 1
    fi
    if [ "$GH_SCENARIO" = 'label-delete-failure' ]; then
      echo 'HTTP 500' >&2
      exit 1
    fi
    printf '%s\\n' '{}'
    ;;
  *'git/refs/heads/'*)
    if [ "$GH_SCENARIO" = 'branch-delete-failure' ]; then
      echo 'HTTP 500' >&2
      exit 1
    fi
	    if [ "$GH_SCENARIO" = 'branch-already-absent' ]; then
	      echo 'HTTP 404' >&2
	      exit 1
	    fi
	    printf '%s\\n' '{}'
	    ;;
	  *'git/ref/heads/'*)
	    if [ "$GH_SCENARIO" = 'branch-already-absent' ]; then
	      echo 'HTTP 404' >&2
	      exit 1
	    fi
	    printf '%s\\n' '{}'
	    ;;
  *'/comments'*)
    if [ "$GH_SCENARIO" = 'comment-failure' ]; then
      echo 'HTTP 500' >&2
      exit 1
    fi
    printf '%s\\n' '{}'
	    ;;
	  *)
	    echo "Unexpected gh call: $*" >&2
	    exit 1
	    ;;
esac
`,
	);
	chmodSync(ghPath, 0o755);
	writeFileSync(
		eventPath,
		JSON.stringify({
			pull_request: {
				base: { ref: 'main', sha: 'base-sha' },
				head: {
					repo: { full_name: 'FerdiHS/devradar' },
					ref: 'release-please--branches--main--components--devradar',
					sha: 'head-sha',
				},
				user: { login: 'release-please[bot]' },
				draft: false,
				body: 'This PR was generated with Release Please.',
				updated_at: '2026-07-31T00:00:00Z',
			},
		}),
	);

	return {
		callsPath,
		directory,
		eventPath,
		outputPath,
		path: `${binDirectory}:${process.env.PATH ?? ''}`,
		scenario,
	};
}

function approvalEnvironment(
	fixture: ApprovalShellFixture,
	override: Record<string, string> = {},
) {
	return {
		ACTION: 'labeled',
		ACTOR_LOGIN: 'FerdiHS',
		GH_CALLS: fixture.callsPath,
		GH_SCENARIO: fixture.scenario,
		GH_TOKEN: 'sanitized-token',
		READ_GH_TOKEN: 'sanitized-read-token',
		EVALUATION_RESULT: 'success',
		GITHUB_EVENT_PATH: fixture.eventPath,
		GITHUB_OUTPUT: fixture.outputPath,
		HEAD_REF: 'release-please--branches--main--components--devradar',
		HEAD_SHA: 'head-sha',
		LABEL_NAME: 'release: ready',
		APPROVED_UPDATED_AT: '2026-07-31T00:00:00Z',
		PATH: fixture.path,
		PR_NUMBER: '123',
		RELEASE_PLEASE_APP_SLUG: 'release-please',
		REPOSITORY: 'FerdiHS/devradar',
		...override,
	};
}

function validApprovalInput(override: Partial<ApprovalInput> = {}) {
	return {
		action: 'labeled',
		labelName: 'release: ready',
		actorLogin: 'FerdiHS',
		repository: 'FerdiHS/devradar',
		baseRef: 'main',
		headRepository: 'FerdiHS/devradar',
		headRef: 'release-please--branches--main--components--devradar',
		headSha: '0123456789abcdef',
		authorLogin: 'release-please[bot]',
		draft: false,
		body: 'This PR was generated with Release Please.',
		releasePleaseAppSlug: 'release-please',
		checkRuns: [
			{
				name: 'Quality checks - Node.js 22.x',
				status: 'completed',
				conclusion: 'success',
				completed_at: '2026-07-31T00:00:00Z',
			},
			{
				name: 'Quality checks - Node.js 24.x',
				status: 'completed',
				conclusion: 'success',
				completed_at: '2026-07-31T00:00:00Z',
			},
		],
		statuses: [
			{
				context: 'external-check',
				state: 'success',
				updated_at: '2026-07-31T00:00:00Z',
			},
		],
		...override,
	};
}

function writeFixtureFiles(cwd: string) {
	writeFileSync(
		join(cwd, 'package.json'),
		JSON.stringify({ version: '0.0.2' }, null, '\t'),
	);
	writeFileSync(
		join(cwd, 'manifest.json'),
		JSON.stringify(
			{ minAppVersion: '1.0.0', version: '0.0.1' },
			null,
			'\t',
		),
	);
	writeFileSync(
		join(cwd, 'versions.json'),
		JSON.stringify({ '0.0.1': '1.0.0' }, null, '\t'),
	);
}

function createGitFixture() {
	const root = mkdtempSync(join(tmpdir(), 'devradar-release-workflow-'));
	const remote = join(root, 'remote.git');
	const checkout = join(root, 'checkout');

	git(root, ['init', '--bare', remote]);
	git(root, ['init', '--initial-branch=main', checkout]);
	git(checkout, ['config', 'user.name', 'DevRadar test']);
	git(checkout, ['config', 'user.email', 'test@example.com']);
	writeFixtureFiles(checkout);
	writeFileSync(
		join(checkout, 'version-bump.mjs'),
		readFileSync(join(repositoryRoot, 'version-bump.mjs'), 'utf8'),
	);
	writeFileSync(
		join(checkout, 'version-bump-core.mjs'),
		readFileSync(join(repositoryRoot, 'version-bump-core.mjs'), 'utf8'),
	);
	git(checkout, ['add', '.']);
	git(checkout, ['commit', '-m', 'base']);
	git(checkout, ['remote', 'add', 'origin', remote]);
	git(checkout, ['push', '-u', 'origin', 'main']);

	return { checkout, remote };
}

function prepareReleaseBranch() {
	const fixture = createGitFixture();
	const headRef = 'release-please--branches--main--components--devradar';

	git(fixture.checkout, ['checkout', '-b', headRef]);
	git(fixture.checkout, ['push', '-u', 'origin', headRef]);

	return { ...fixture, headRef };
}

const trustedBaseStep = extractRunStep(
	versionSyncWorkflow,
	'Sync metadata with trusted script',
);
const guardStep = extractRunStep(versionSyncWorkflow, 'Guard changed files');
const pushStep = extractRunStep(versionSyncWorkflow, 'Push metadata changes');
const approvalEvaluationStep = extractRunStep(
	approvalWorkflow,
	'Evaluate approval policy',
);
const approvalMutationStep = extractRunStep(
	approvalWorkflow,
	'Invalidate, reject, or merge',
);

describe('Release Please approval policy', () => {
	it('approves a qualifying Release Please pull request', () => {
		expect(evaluateReleaseApproval(validApprovalInput())).toMatchObject({
			decision: 'approve',
		});
	});

	it.each([
		['wrong actor', { actorLogin: 'another-user' }],
		['fork', { headRepository: 'someone/fork' }],
		['draft', { draft: true }],
		['wrong base', { baseRef: 'release' }],
		[
			'wrong Release Please branch',
			{
				headRef:
					'release-please--branches--release--components--devradar',
			},
		],
		['wrong bot', { authorLogin: 'human' }],
		['missing marker', { body: 'ordinary body' }],
		['missing repository', { repository: '' }],
		['missing head SHA', { headSha: '' }],
		['missing app slug', { releasePleaseAppSlug: '' }],
	])('%s is rejected', (_name, override) => {
		expect(
			evaluateReleaseApproval(validApprovalInput(override)),
		).toMatchObject({
			decision: 'reject',
		});
	});

	it.each(['synchronize', 'converted_to_draft', 'reopened'])(
		'%s invalidates a previous approval',
		(action) => {
			expect(
				evaluateReleaseApproval(validApprovalInput({ action })),
			).toEqual({
				decision: 'invalidate',
			});
		},
	);

	it('ignores an unrelated label', () => {
		expect(
			evaluateReleaseApproval(validApprovalInput({ labelName: 'bug' })),
		).toEqual({ decision: 'ignore' });
	});

	it.each([
		['Node 22 is missing', []],
		[
			'Node 24 is missing',
			[
				{
					name: 'Quality checks - Node.js 22.x',
					status: 'completed',
					conclusion: 'success',
					completed_at: '2026-07-31T00:00:00Z',
				},
			],
		],
		[
			'latest check is pending',
			[
				...validApprovalInput().checkRuns,
				{
					name: 'Quality checks - Node.js 22.x',
					status: 'in_progress',
					conclusion: null,
					started_at: '2026-07-31T01:00:00Z',
				},
			],
		],
		[
			'latest check failed',
			[
				...validApprovalInput().checkRuns,
				{
					name: 'Quality checks - Node.js 24.x',
					status: 'completed',
					conclusion: 'failure',
					completed_at: '2026-07-31T01:00:00Z',
				},
			],
		],
		[
			'latest check was skipped',
			[
				...validApprovalInput().checkRuns,
				{
					name: 'Quality checks - Node.js 24.x',
					status: 'completed',
					conclusion: 'skipped',
					completed_at: '2026-07-31T01:00:00Z',
				},
			],
		],
		[
			'latest check replaces an earlier success',
			[
				...validApprovalInput().checkRuns,
				{
					name: 'Quality checks - Node.js 22.x',
					status: 'completed',
					conclusion: 'failure',
					completed_at: '2026-07-31T01:00:00Z',
				},
			],
		],
	] as const)('%s is rejected', (_name, checkRuns) => {
		expect(
			evaluateReleaseApproval(
				validApprovalInput({ checkRuns: [...checkRuns] }),
			),
		).toMatchObject({ decision: 'reject' });
	});

	it.each(['error', 'failure', 'pending'])(
		'%s status is rejected',
		(state) => {
			expect(
				evaluateReleaseApproval(
					validApprovalInput({
						statuses: [
							{
								context: 'external-check',
								state,
								updated_at: '2026-07-31T01:00:00Z',
							},
						],
					}),
				),
			).toMatchObject({ decision: 'reject' });
		},
	);

	it('uses the newest status for each context', () => {
		expect(
			evaluateReleaseApproval(
				validApprovalInput({
					statuses: [
						{
							context: 'external-check',
							state: 'success',
							updated_at: '2026-07-31T02:00:00Z',
						},
						{
							context: 'external-check',
							state: 'failure',
							updated_at: '2026-07-31T01:00:00Z',
						},
					],
				}),
			),
		).toMatchObject({ decision: 'approve' });

		expect(
			evaluateReleaseApproval(
				validApprovalInput({
					statuses: [
						{
							context: 'external-check',
							state: 'failure',
							updated_at: '2026-07-31T02:00:00Z',
						},
						{
							context: 'external-check',
							state: 'success',
							updated_at: '2026-07-31T01:00:00Z',
						},
					],
				}),
			),
		).toMatchObject({ decision: 'reject' });
	});

	it('requires every current status context to succeed', () => {
		expect(
			evaluateReleaseApproval(
				validApprovalInput({
					statuses: [
						{
							context: 'external-check',
							state: 'success',
							updated_at: '2026-07-31T01:00:00Z',
						},
						{
							context: 'another-check',
							state: 'success',
							updated_at: '2026-07-31T01:00:00Z',
						},
					],
				}),
			),
		).toMatchObject({ decision: 'approve' });
	});

	it('ignores its own pending check while gating every external check', () => {
		expect(
			evaluateReleaseApproval(
				validApprovalInput({
					checkRuns: [
						...validApprovalInput().checkRuns,
						{
							name: 'Approve Release Please',
							status: 'in_progress',
							conclusion: null,
							started_at: '2026-07-31T01:00:00Z',
						},
					],
				}),
			),
		).toMatchObject({ decision: 'approve' });
	});

	it('rejects a failed external check', () => {
		expect(
			evaluateReleaseApproval(
				validApprovalInput({
					checkRuns: [
						...validApprovalInput().checkRuns,
						{
							name: 'Security scan',
							status: 'completed',
							conclusion: 'failure',
							completed_at: '2026-07-31T01:00:00Z',
						},
					],
				}),
			),
		).toMatchObject({ decision: 'reject' });
	});
});

describe('Release Please version sync shell steps', () => {
	it('runs metadata synchronization from the trusted base scripts only', () => {
		const { checkout } = createGitFixture();
		const baseSha = git(checkout, ['rev-parse', 'HEAD']);
		const trustedDirectory = join(checkout, 'trusted');

		writeFileSync(
			join(checkout, 'version-bump.mjs'),
			"throw new Error('malicious head script executed');\n",
		);
		writeFileSync(
			join(checkout, 'version-bump-core.mjs'),
			"throw new Error('malicious head helper executed');\n",
		);
		git(checkout, ['add', 'version-bump.mjs', 'version-bump-core.mjs']);
		git(checkout, ['commit', '-m', 'malicious head']);
		mkdirSync(trustedDirectory);

		runBash(trustedBaseStep, checkout, {
			BASE_SHA: baseSha,
			TRUSTED_HELPER: join(trustedDirectory, 'version-bump-core.mjs'),
			TRUSTED_SCRIPT: join(trustedDirectory, 'version-bump.mjs'),
		});

		expect(git(checkout, ['diff', '--name-only']).split('\n')).toEqual([
			'manifest.json',
			'versions.json',
		]);
		expect(readFileSync(join(checkout, 'manifest.json'), 'utf8')).toContain(
			'"version": "0.0.2"',
		);
	});

	it('guard succeeds when no files changed', () => {
		const { checkout } = createGitFixture();

		expect(() => runBash(guardStep, checkout)).not.toThrow();
	});

	it('guard accepts only manifest.json and versions.json changes', () => {
		const { checkout } = createGitFixture();

		writeFileSync(join(checkout, 'manifest.json'), '{"version":"0.0.2"}\n');
		writeFileSync(join(checkout, 'versions.json'), '{"0.0.2":"1.0.0"}\n');

		expect(() => runBash(guardStep, checkout)).not.toThrow();
	});

	it('guard rejects an unexpected tracked file', () => {
		const { checkout } = createGitFixture();

		writeFileSync(join(checkout, 'package.json'), '{"version":"0.0.3"}\n');

		expect(() => runBash(guardStep, checkout)).toThrow(
			/Unexpected files changed/,
		);
	});

	it.each(['manifest.json.bak', 'versions.json.bak'])(
		'guard rejects the lookalike tracked file %s',
		(fileName) => {
			const { checkout } = createGitFixture();

			writeFileSync(join(checkout, fileName), 'lookalike\n');
			git(checkout, ['add', fileName]);
			git(checkout, ['commit', '-m', `track ${fileName}`]);
			writeFileSync(join(checkout, fileName), 'modified lookalike\n');

			expect(() => runBash(guardStep, checkout)).toThrow(
				/Unexpected files changed/,
			);
		},
	);

	it('guard rejects an unexpected untracked file', () => {
		const { checkout } = createGitFixture();

		writeFileSync(join(checkout, 'unexpected.txt'), 'unexpected\n');

		expect(() => runBash(guardStep, checkout)).toThrow(
			/Unexpected untracked files/,
		);
	});

	it('push exits without committing or pushing when no changes are needed', () => {
		const { checkout, remote, headRef } = prepareReleaseBranch();
		const checkoutHead = git(checkout, ['rev-parse', 'HEAD']);
		const remoteHead = git(remote, ['rev-parse', 'refs/heads/' + headRef]);

		expect(() =>
			runBash(pushStep, checkout, {
				PUSH_URL: join(checkout, 'missing-remote.git'),
				EXPECTED_HEAD_SHA: checkoutHead,
				HEAD_REF: headRef,
			}),
		).not.toThrow();

		expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(checkoutHead);
		expect(git(remote, ['rev-parse', 'refs/heads/' + headRef])).toBe(
			remoteHead,
		);
	});

	it('push rejects a stale remote head without changing the remote', () => {
		expect(pushStep).toContain('PUSH_URL');
		const { checkout, remote, headRef } = prepareReleaseBranch();
		const remoteHead = git(remote, ['rev-parse', `refs/heads/${headRef}`]);

		writeFileSync(join(checkout, 'manifest.json'), '{"version":"0.0.2"}\n');

		expect(() =>
			runBash(pushStep, checkout, {
				PUSH_URL: remote,
				EXPECTED_HEAD_SHA: '0000000000000000000000000000000000000000',
				HEAD_REF: headRef,
			}),
		).toThrow(/branch head changed/);
		expect(git(remote, ['rev-parse', `refs/heads/${headRef}`])).toBe(
			remoteHead,
		);
	});

	it('pushes metadata with a matching remote head', () => {
		expect(pushStep).toContain('PUSH_URL');
		const { checkout, remote, headRef } = prepareReleaseBranch();
		const expectedHeadSha = git(checkout, ['rev-parse', 'HEAD']);

		writeFileSync(join(checkout, 'manifest.json'), '{"version":"0.0.2"}\n');

		runBash(pushStep, checkout, {
			PUSH_URL: remote,
			EXPECTED_HEAD_SHA: expectedHeadSha,
			HEAD_REF: headRef,
		});

		expect(git(remote, ['rev-parse', `refs/heads/${headRef}`])).toBe(
			git(checkout, ['rev-parse', 'HEAD']),
		);
		expect(
			git(checkout, ['show', '--format=%s', '--no-patch', 'HEAD']),
		).toBe('chore(release): sync Obsidian metadata');
	});
});

describe('Release Please approval shell steps', () => {
	it('evaluates and merges a qualifying Release Please pull request', () => {
		const fixture = createApprovalShellFixture('success');

		runBash(
			approvalEvaluationStep,
			repositoryRoot,
			approvalEnvironment(fixture),
		);
		const outputs = readWorkflowOutputs(fixture.outputPath);

		expect(outputs).toMatchObject({
			decision: 'approve',
			operational_failure: 'false',
		});
		runBash(
			approvalMutationStep,
			repositoryRoot,
			approvalEnvironment(fixture, {
				DECISION: outputs.decision,
				OPERATIONAL_FAILURE: outputs.operational_failure,
				REASON: outputs.reason,
			}),
		);
		const calls = readFileSync(fixture.callsPath, 'utf8');

		expect(calls).toContain('/merge');
		expect(calls).toContain('merge_method=squash');
		expect(calls).toContain('git/refs/heads/');
	});

	it.each([
		'current-base-changed',
		'current-label-removed',
		'current-reopened',
		'current-draft',
		'current-head-changed',
		'current-check-failure',
		'current-status-failure',
	])('does not merge when live approval state changes: %s', (scenario) => {
		const fixture = createApprovalShellFixture(scenario);

		expect(() =>
			runBash(
				approvalMutationStep,
				repositoryRoot,
				approvalEnvironment(fixture, {
					DECISION: 'approve',
					OPERATIONAL_FAILURE: 'false',
					REASON: '',
				}),
			),
		).not.toThrow();
		const calls = readFileSync(fixture.callsPath, 'utf8');

		expect(calls).toContain('/pulls/');
		expect(calls).not.toContain('/merge');
		expect(calls).toContain('/labels/release%3A%20ready');
		expect(calls).toContain('/comments');
	});

	it('cleans up when evaluation fails before producing outputs', () => {
		const fixture = createApprovalShellFixture('evaluation-failure');

		expect(() =>
			runBash(
				approvalMutationStep,
				repositoryRoot,
				approvalEnvironment(fixture, {
					DECISION: '',
					EVALUATION_RESULT: 'failure',
					OPERATIONAL_FAILURE: '',
					REASON: '',
				}),
			),
		).toThrow(/Operational failure/);
		const calls = readFileSync(fixture.callsPath, 'utf8');

		expect(calls).toContain('/labels/release%3A%20ready');
		expect(calls).toContain('/comments');
		expect(calls).not.toContain('/merge');
	});

	it.each(['check-api-failure', 'status-api-failure'])(
		'signals the %s after cleanup',
		(scenario) => {
			const fixture = createApprovalShellFixture(scenario);

			runBash(
				approvalEvaluationStep,
				repositoryRoot,
				approvalEnvironment(fixture),
			);
			const outputs = readWorkflowOutputs(fixture.outputPath);

			expect(outputs).toMatchObject({
				decision: 'reject',
				operational_failure: 'true',
			});
			expect(() =>
				runBash(
					approvalMutationStep,
					repositoryRoot,
					approvalEnvironment(fixture, {
						DECISION: outputs.decision,
						OPERATIONAL_FAILURE: outputs.operational_failure,
						REASON: outputs.reason,
					}),
				),
			).toThrow(/Operational failure/);
			const calls = readFileSync(fixture.callsPath, 'utf8');

			expect(calls).toContain('/labels/release%3A%20ready');
			expect(calls).toContain('/comments');
		},
	);

	it('treats an exact-head merge conflict as an expected rejection', () => {
		const fixture = createApprovalShellFixture('stale-head');

		expect(() =>
			runBash(
				approvalMutationStep,
				repositoryRoot,
				approvalEnvironment(fixture, {
					DECISION: 'approve',
					OPERATIONAL_FAILURE: 'false',
					REASON: '',
				}),
			),
		).not.toThrow();
		const calls = readFileSync(fixture.callsPath, 'utf8')
			.trim()
			.split('\n');
		const mergeCalls = calls.filter((call) => call.includes('/merge'));

		expect(mergeCalls).toHaveLength(1);
		expect(mergeCalls[0]).toContain('sha=head-sha');
		expect(calls.join('\n')).toContain('/merge');
		expect(calls.join('\n')).toContain('/labels/release%3A%20ready');
		expect(calls.join('\n')).toContain('/comments');
	});

	it('returns nonzero for an operational merge failure after cleanup', () => {
		const fixture = createApprovalShellFixture('merge-api-failure');

		expect(() =>
			runBash(
				approvalMutationStep,
				repositoryRoot,
				approvalEnvironment(fixture, {
					DECISION: 'approve',
					OPERATIONAL_FAILURE: 'false',
					REASON: '',
				}),
			),
		).toThrow(/Operational failure/);
		const calls = readFileSync(fixture.callsPath, 'utf8');

		expect(calls).toContain('/merge');
		expect(calls).toContain('/labels/release%3A%20ready');
		expect(calls).toContain('/comments');
	});

	it('comments and returns nonzero when branch deletion fails after merge', () => {
		const fixture = createApprovalShellFixture('branch-delete-failure');

		expect(() =>
			runBash(
				approvalMutationStep,
				repositoryRoot,
				approvalEnvironment(fixture, {
					DECISION: 'approve',
					OPERATIONAL_FAILURE: 'false',
					REASON: '',
				}),
			),
		).toThrow(/Operational failure/);
		const calls = readFileSync(fixture.callsPath, 'utf8')
			.trim()
			.split('\n');
		const mergeIndex = calls.findIndex((call) => call.includes('/merge'));
		const deleteIndex = calls.findIndex((call) =>
			call.includes('git/refs/heads/'),
		);
		const commentIndex = calls.findIndex((call) =>
			call.includes('/comments'),
		);

		expect(mergeIndex).toBeGreaterThanOrEqual(0);
		expect(deleteIndex).toBeGreaterThan(mergeIndex);
		expect(commentIndex).toBeGreaterThan(deleteIndex);
	});

	it('treats an already-deleted branch as successful cleanup', () => {
		const fixture = createApprovalShellFixture('branch-already-absent');

		expect(() =>
			runBash(
				approvalMutationStep,
				repositoryRoot,
				approvalEnvironment(fixture, {
					DECISION: 'approve',
					OPERATIONAL_FAILURE: 'false',
					REASON: '',
				}),
			),
		).not.toThrow();
		const calls = readFileSync(fixture.callsPath, 'utf8');

		expect(calls).toContain('/merge');
		expect(calls).toContain('git/refs/heads/');
		expect(calls).toContain('git/ref/heads/');
		expect(calls).not.toContain('/comments');
	});

	it('returns nonzero when label cleanup fails', () => {
		const fixture = createApprovalShellFixture('label-delete-failure');

		expect(() =>
			runBash(
				approvalMutationStep,
				repositoryRoot,
				approvalEnvironment(fixture, {
					DECISION: 'reject',
					OPERATIONAL_FAILURE: 'false',
					REASON: 'The approval policy rejected this pull request.',
				}),
			),
		).toThrow(/Operational failure/);
		const calls = readFileSync(fixture.callsPath, 'utf8');

		expect(calls).toContain('/labels/release%3A%20ready');
		expect(calls).not.toContain('/comments');
	});

	it('returns nonzero when rejection commenting fails', () => {
		const fixture = createApprovalShellFixture('comment-failure');

		expect(() =>
			runBash(
				approvalMutationStep,
				repositoryRoot,
				approvalEnvironment(fixture, {
					DECISION: 'reject',
					OPERATIONAL_FAILURE: 'false',
					REASON: 'The approval policy rejected this pull request.',
				}),
			),
		).toThrow(/Operational failure/);
		const calls = readFileSync(fixture.callsPath, 'utf8');

		expect(calls).toContain('/labels/release%3A%20ready');
		expect(calls).toContain('/comments');
	});

	it('keeps invalidate for an ordinary pull request without a ready label', () => {
		const fixture = createApprovalShellFixture('missing-label');

		runBash(
			approvalEvaluationStep,
			repositoryRoot,
			approvalEnvironment(fixture, {
				ACTION: 'synchronize',
				ACTOR_LOGIN: 'ordinary-user',
				LABEL_NAME: '',
			}),
		);
		const outputs = readWorkflowOutputs(fixture.outputPath);

		expect(outputs).toMatchObject({
			decision: 'invalidate',
			operational_failure: 'false',
		});
	});

	it.each(['synchronize', 'converted_to_draft', 'reopened'])(
		'%s removes a previous approval',
		(action) => {
			const fixture = createApprovalShellFixture('success');

			runBash(
				approvalEvaluationStep,
				repositoryRoot,
				approvalEnvironment(fixture, { ACTION: action }),
			);
			const outputs = readWorkflowOutputs(fixture.outputPath);

			expect(outputs.decision).toBe('invalidate');
			runBash(
				approvalMutationStep,
				repositoryRoot,
				approvalEnvironment(fixture, {
					DECISION: outputs.decision,
					OPERATIONAL_FAILURE: outputs.operational_failure,
					REASON: outputs.reason,
				}),
			);

			const calls = readFileSync(fixture.callsPath, 'utf8');
			expect(calls).toContain('/labels/release%3A%20ready');
			expect(calls).not.toContain('/comments');
			expect(calls).not.toContain('/merge');
		},
	);
});

describe('Release Please workflow contracts', () => {
	it('keeps the approval workflow and policy safeguards', () => {
		expect(approvalWorkflow).toContain('pull_request_target');
		for (const event of [
			'labeled',
			'synchronize',
			'converted_to_draft',
			'reopened',
		]) {
			expect(approvalWorkflow).toContain(event);
		}
		expect(approvalWorkflow).toMatch(
			/Checkout trusted base[\s\S]*?ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}[\s\S]*?persist-credentials: false/,
		);
		for (const workflowTerm of [
			'node .github/scripts/release-please-approval.mjs',
			'head.repo.full_name',
			'base.ref',
			'RELEASE_PLEASE_APP_SLUG',
			'pullRequest.draft',
			'/statuses?per_page=100',
			'-f sha="${HEAD_SHA}"',
			'merge_method=squash',
			'git/refs/heads/${HEAD_REF}',
			'actions/create-github-app-token@v3',
			'private-key: ${{ secrets.RELEASE_PLEASE_APP_PRIVATE_KEY }}',
		]) {
			expect(approvalWorkflow).toContain(workflowTerm);
		}
		expect(approvalWorkflow).toContain('always()');
		expect(approvalWorkflow).toContain('needs.evaluate.result');
		expect(approvalWorkflow).toMatch(
			/mutate:[\s\S]*?Checkout trusted base[\s\S]*?continue-on-error: true[\s\S]*?Create GitHub App token/,
		);
		expect(approvalWorkflow).toContain(
			'READ_GH_TOKEN: ${{ github.token }}',
		);
		expect(approvalWorkflow).not.toContain('permission-checks: read');
		expect(approvalWorkflow).not.toContain('permission-statuses: read');
		for (const policyTerm of [
			'FerdiHS',
			'release-please--branches--main--components--devradar',
			'This PR was generated with Release Please.',
			'Quality checks - Node.js 22.x',
			'Quality checks - Node.js 24.x',
		]) {
			expect(approvalPolicy).toContain(policyTerm);
		}
		expect(approvalWorkflow).not.toMatch(/auto-merge|admin|--force/);
	});

	it('keeps version synchronization on the trusted exact head', () => {
		expect(versionSyncWorkflow).toMatch(
			/pull_request_target[\s\S]*?branches:\s*\n\s+- main/,
		);
		for (const conditionTerm of [
			'github.event.pull_request.head.repo.full_name == github.repository',
			'!github.event.pull_request.draft',
			"github.event.pull_request.head.ref == 'release-please--branches--main--components--devradar'",
		]) {
			expect(versionSyncWorkflow).toContain(conditionTerm);
		}
		expect(versionSyncWorkflow).toContain(
			'ref: ${{ github.event.pull_request.head.sha }}',
		);
		expect(versionSyncWorkflow).toMatch(
			/Checkout Release Please PR[\s\S]*?persist-credentials: false/,
		);
		expect(versionSyncWorkflow).toContain(
			'git show "${BASE_SHA}:version-bump.mjs"',
		);
		expect(versionSyncWorkflow).toContain(
			'git show "${BASE_SHA}:version-bump-core.mjs"',
		);
		expect(versionSyncWorkflow).toContain(
			'git ls-files --others --exclude-standard',
		);
		expect(versionSyncWorkflow).toContain(
			"github.event.pull_request.user.login == format('{0}[bot]', vars.RELEASE_PLEASE_APP_SLUG)",
		);
		expect(versionSyncWorkflow).toContain(
			"contains(github.event.pull_request.body, 'This PR was generated with Release Please.')",
		);
		expect(versionSyncWorkflow).toContain('git ls-remote');
		expect(versionSyncWorkflow).not.toContain('--force-with-lease');
		expect(versionSyncWorkflow).not.toContain('git push --force');
		expect(versionSyncWorkflow.indexOf('Guard changed files')).toBeLessThan(
			versionSyncWorkflow.indexOf('Create GitHub App token'),
		);
		expect(pushStep).toMatch(
			/git push "\$PUSH_URL" "HEAD:refs\/heads\/\$\{HEAD_REF\}"/,
		);
	});
});
