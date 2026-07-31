import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
	statuses: { state: string }[];
};

type ApprovalDecision = {
	decision: string;
	reason?: string;
};

type EvaluateReleaseApproval = (input: ApprovalInput) => ApprovalDecision;

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
		statuses: [{ state: 'success' }],
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
		['wrong bot', { authorLogin: 'human' }],
		['missing marker', { body: 'ordinary body' }],
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
					validApprovalInput({ statuses: [{ state }] }),
				),
			).toMatchObject({ decision: 'reject' });
		},
	);

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

	it('guard rejects an unexpected untracked file', () => {
		const { checkout } = createGitFixture();

		writeFileSync(join(checkout, 'unexpected.txt'), 'unexpected\n');

		expect(() => runBash(guardStep, checkout)).toThrow(
			/Unexpected untracked files/,
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
