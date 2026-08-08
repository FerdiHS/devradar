import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	isAlias,
	isMap,
	isScalar,
	isSeq,
	parseDocument,
	type YAMLMap,
} from 'yaml';
import { describe, expect, it } from 'vitest';

type ActionInvocation = {
	filePath: string;
	reference: string;
	line: number;
	comment: string;
};

const actionReferencePattern =
	/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/;
const releaseCommentPattern = /^v\d+\.\d+\.\d+$/;

function mapValue(map: YAMLMap, key: string) {
	return map.items.find(
		(pair) => isScalar(pair.key) && pair.key.value === key,
	)?.value;
}

function collectStepActionInvocations(
	source: string,
	filePath: string,
): ActionInvocation[] {
	const document = parseDocument(source);
	if (document.errors.length > 0) {
		throw new Error(`${filePath}: invalid YAML`);
	}
	const resolve = (value: unknown) => {
		let resolved = value;
		while (isAlias(resolved)) {
			resolved = resolved.resolve(document);
		}
		return resolved;
	};

	const contents = resolve(document.contents);
	if (!isMap(contents)) {
		throw new Error(`${filePath}: expected a workflow mapping`);
	}

	const jobs = resolve(mapValue(contents, 'jobs'));
	if (!isMap(jobs)) {
		throw new Error(`${filePath}: expected a jobs mapping`);
	}

	const invocations: ActionInvocation[] = [];
	for (const job of jobs.items) {
		const jobValue = resolve(job.value);
		if (!isMap(jobValue)) {
			throw new Error(`${filePath}: expected a job mapping`);
		}

		const steps = resolve(mapValue(jobValue, 'steps'));
		if (steps === undefined) {
			continue;
		}
		if (!isSeq(steps)) {
			throw new Error(`${filePath}: expected a steps sequence`);
		}

		for (const step of steps.items) {
			const stepValue = resolve(step);
			if (!isMap(stepValue)) {
				throw new Error(`${filePath}: expected a step mapping`);
			}

			const uses = mapValue(stepValue, 'uses');
			if (!isAlias(uses) && !isScalar(uses)) {
				continue;
			}

			const action = resolve(uses);
			if (!isScalar(action) || typeof action.value !== 'string') {
				continue;
			}

			if (action.value.startsWith('./')) {
				continue;
			}

			const offset = uses.range?.[0] ?? 0;
			invocations.push({
				filePath,
				reference: action.value,
				line: source.slice(0, offset).split('\n').length,
				comment: uses.comment?.trim() ?? '',
			});
		}
	}

	return invocations;
}

function isPinnedAction(invocation: ActionInvocation) {
	return (
		actionReferencePattern.test(invocation.reference) &&
		releaseCommentPattern.test(invocation.comment)
	);
}

describe('workflow action pinning', () => {
	it('collects only external job-step actions', () => {
		const invocations = collectStepActionInvocations(
			`jobs:
    external:
        steps:
            - uses: owner/action@0123456789012345678901234567890123456789 # v1.2.3
    local:
        steps:
            - uses: ./.github/actions/local
    reusable:
        uses: owner/repo/.github/workflows/reuse.yml@v1
`,
			'fixture.yml',
		);

		expect(invocations).toEqual([
			{
				filePath: 'fixture.yml',
				reference:
					'owner/action@0123456789012345678901234567890123456789',
				line: 4,
				comment: 'v1.2.3',
			},
		]);
	});

	it('rejects malformed workflow YAML', () => {
		expect(() =>
			collectStepActionInvocations('jobs: [', 'fixture.yml'),
		).toThrow('fixture.yml: invalid YAML');
	});

	it('collects aliased external actions while excluding local and reusable uses', () => {
		const invocations = collectStepActionInvocations(
			`jobs:
    external:
        steps:
            - uses: &pinned-action owner/action@0123456789012345678901234567890123456789 # v1.2.3
            - uses: *pinned-action # v1.2.3
            - uses: *pinned-action
    local:
        steps:
            - uses: &local-action ./.github/actions/local
            - uses: *local-action
    reusable:
        uses: &reusable-workflow owner/repo/.github/workflows/reuse.yml@v1
`,
			'fixture.yml',
		);

		expect(invocations).toEqual([
			{
				filePath: 'fixture.yml',
				reference:
					'owner/action@0123456789012345678901234567890123456789',
				line: 4,
				comment: 'v1.2.3',
			},
			{
				filePath: 'fixture.yml',
				reference:
					'owner/action@0123456789012345678901234567890123456789',
				line: 5,
				comment: 'v1.2.3',
			},
			{
				filePath: 'fixture.yml',
				reference:
					'owner/action@0123456789012345678901234567890123456789',
				line: 6,
				comment: '',
			},
		]);
		expect(invocations.slice(0, 2).every(isPinnedAction)).toBe(true);
		expect(isPinnedAction(invocations[2]!)).toBe(false);
	});

	it('validates aliases around jobs, steps, and step mappings', () => {
		const invocations = collectStepActionInvocations(
			`jobs:
    template: &template
        steps:
            - uses: owner/action@v1 # v1.0.0
    copied: *template
    shared:
        steps: &shared-steps
            - uses: owner/action@v1 # v1.0.0
    copied-steps:
        steps: *shared-steps
    whole-step:
        steps:
            - &whole-step
              uses: owner/action@v1 # v1.0.0
            - *whole-step
`,
			'fixture.yml',
		);

		expect(invocations).toHaveLength(6);
		expect(
			invocations.every(
				({ reference }) => reference === 'owner/action@v1',
			),
		).toBe(true);
		expect(
			invocations.every((invocation) => !isPinnedAction(invocation)),
		).toBe(true);
	});

	it.each([
		[
			'owner/action@0123456789012345678901234567890123456789',
			'v1.2.3',
			true,
		],
		[
			'owner/action/path@0123456789012345678901234567890123456789',
			'v1.2.3',
			true,
		],
		['owner/action@v6', 'v6.0.0', false],
		['owner/action@main', 'v1.2.3', false],
		['owner/action@0123456', 'v1.2.3', false],
		['owner/action@0123456789012345678901234567890123456789', '', false],
		['owner/action@0123456789012345678901234567890123456789', 'v1', false],
	])(
		'accepts immutable references and exact release comments',
		(reference, comment, expected) => {
			expect(
				isPinnedAction({
					filePath: 'fixture.yml',
					reference,
					line: 1,
					comment,
				}),
			).toBe(expected);
		},
	);

	it('pins every external action used by repository workflow steps', () => {
		const workflowsDirectory = join(process.cwd(), '.github/workflows');
		const invocations = readdirSync(workflowsDirectory)
			.filter((fileName) => /\.ya?ml$/.test(fileName))
			.flatMap((fileName) => {
				const filePath = join(workflowsDirectory, fileName);
				return collectStepActionInvocations(
					readFileSync(filePath, 'utf8'),
					filePath,
				);
			});

		expect(invocations).not.toHaveLength(0);
		for (const invocation of invocations) {
			expect(
				invocation.reference,
				`${invocation.filePath}:${invocation.line}`,
			).toMatch(actionReferencePattern);
			expect(
				invocation.comment,
				`${invocation.filePath}:${invocation.line}`,
			).toMatch(releaseCommentPattern);
		}
	});
});
