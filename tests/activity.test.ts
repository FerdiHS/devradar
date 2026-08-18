import { describe, expect, it } from 'vitest';
import {
	canonicalizeEventId,
	canonicalizePositiveNumber,
	canonicalizeRepository,
	canonicalizeTimestamp,
	compareActivities,
	createIssueActivity,
	createPullRequestActivity,
	createPushActivity,
	isActivityEligible,
	normalizeProviderText,
	serializeActivityFragment,
	validateCommitId,
	validateRef,
} from '../src/domain/activity';

const ok = <T>(result: { ok: boolean; value?: T }): T => {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error('expected successful validation');
	return result.value as T;
};

const bad = (result: { ok: boolean }) => expect(result.ok).toBe(false);

const base = {
	providerEventId: '123',
	timestamp: '2026-08-18T01:02:03.123400Z',
	repository: 'octocat/hello-world',
};

describe('canonical primitive validation', () => {
	it('canonicalizes positive event IDs and rejects malformed forms', () => {
		expect(ok(canonicalizeEventId('123'))).toBe('123');
		for (const input of ['', '0', '-1', '+1', '1.0', '01', '1e3', 'abc']) {
			bad(canonicalizeEventId(input));
		}
		bad(canonicalizeEventId(Number.MAX_SAFE_INTEGER + 1));
		bad(canonicalizeEventId(1.5));
		expect(ok(canonicalizeEventId(42))).toBe('42');
	});

	it('validates repository identities without repairing them', () => {
		expect(ok(canonicalizeRepository('octocat/hello-world'))).toBe(
			'octocat/hello-world',
		);
		for (const input of [
			'octocat',
			'octocat/a/b',
			'octo--cat/repo',
			'-octocat/repo',
			'octocat-/repo',
			'octocat/re]po',
			'octocat/re?po',
			'octocat/re#po',
			'octocat/re%po',
			'octocat\\repo',
			'./repo',
			'octocat/..',
			'octocat/repo/',
			`a${'a'.repeat(39)}/repo`,
			`owner/${'a'.repeat(101)}`,
		])
			bad(canonicalizeRepository(input));
	});

	it('validates positive object numbers, refs, and commit IDs', () => {
		expect(ok(canonicalizePositiveNumber('7'))).toBe('7');
		for (const input of ['0', '-1', '+1', '1.5', '01', '1e2', ''])
			bad(canonicalizePositiveNumber(input));
		for (const input of [
			'',
			'a\\b',
			'a..b',
			'a@{b',
			'@',
			'main.lock',
			'refs/heads/foo.lock',
			'a\nb',
			'a b',
			'a?b',
			'a*b',
			'a:b',
			'.hidden',
			'a~b',
		])
			bad(validateRef(input));
		expect(ok(validateRef('refs/heads/feature/test'))).toBe(
			'refs/heads/feature/test',
		);
		expect(ok(validateCommitId('a'.repeat(40)))).toBe('a'.repeat(40));
		bad(validateCommitId('a'.repeat(39)));
		bad(validateCommitId('g'.repeat(40)));
	});
});

describe('activity construction', () => {
	it('constructs exactly the supported families and actions', () => {
		const push = ok(
			createPushActivity({ ...base, ref: 'refs/heads/main' }),
		);
		expect(push.family).toBe('push');
		for (const action of [
			'opened',
			'reopened',
			'closed',
			'merged',
		] as const) {
			expect(
				ok(
					createPullRequestActivity({
						...base,
						number: '4',
						title: 'Improve docs',
						action,
					}),
				).action,
			).toBe(action);
		}
		for (const action of ['opened', 'reopened', 'closed'] as const) {
			expect(
				ok(
					createIssueActivity({
						...base,
						number: '5',
						title: 'Fix bug',
						action,
					}),
				).action,
			).toBe(action);
		}
		bad(
			createPullRequestActivity({
				...base,
				number: '4',
				title: '',
				action: 'opened',
			}),
		);
	});
});

describe('timestamps, eligibility, and ordering', () => {
	it('normalizes equivalent timestamps without rounding precision', () => {
		expect(ok(canonicalizeTimestamp('2026-08-18T02:02:03.100Z'))).toBe(
			'2026-08-18T02:02:03.1Z',
		);
		expect(
			ok(canonicalizeTimestamp('2026-08-18T03:02:03.123456789012Z')),
		).toBe('2026-08-18T03:02:03.123456789012Z');
		expect(ok(canonicalizeTimestamp('2026-08-18T03:02:03+01:00'))).toBe(
			'2026-08-18T02:02:03Z',
		);
		bad(canonicalizeTimestamp('2026-02-30T03:02:03Z'));
		bad(canonicalizeTimestamp('not-a-timestamp'));
	});

	it('uses an inclusive cutoff and does not apply settings validation', () => {
		expect(
			ok(
				isActivityEligible('2026-08-18T01:00:00Z', {
					mode: 'available-recent',
				}),
			),
		).toBe(true);
		for (const mode of ['from-now', 'from-date'] as const) {
			expect(
				ok(
					isActivityEligible('2026-08-18T01:00:00Z', {
						mode,
						at: '2026-08-18T01:00:00Z',
					}),
				),
			).toBe(true);
			expect(
				ok(
					isActivityEligible('2026-08-18T00:59:59Z', {
						mode,
						at: '2026-08-18T01:00:00Z',
					}),
				),
			).toBe(false);
		}
	});

	it('orders timestamps descending and IDs lexicographically ascending', () => {
		const activities = [
			ok(
				createPushActivity({
					...base,
					providerEventId: '20',
					ref: 'refs/heads/main',
					timestamp: '2026-08-18T02:00:00Z',
				}),
			),
			ok(
				createPushActivity({
					...base,
					providerEventId: '2',
					ref: 'refs/heads/main',
					timestamp: '2026-08-18T02:00:00Z',
				}),
			),
			ok(
				createPushActivity({
					...base,
					providerEventId: '1',
					ref: 'refs/heads/main',
					timestamp: '2026-08-18T03:00:00Z',
				}),
			),
		];
		expect(
			activities
				.sort(compareActivities)
				.map((activity) => activity.providerEventId),
		).toEqual(['1', '2', '20']);
	});
});

describe('safe links and exact fragments', () => {
	it('derives safe push source links and omits unsafe optional links', () => {
		expect(
			ok(createPushActivity({ ...base, ref: 'refs/heads/feature/a,b' })),
		).toMatchObject({
			pushSourceUrl:
				'https://github.com/octocat/hello-world/tree/feature/a%2Cb',
		});
		expect(
			ok(createPushActivity({ ...base, ref: 'refs/tags/v1.0/test' })),
		).toMatchObject({
			pushSourceUrl:
				'https://github.com/octocat/hello-world/tree/v1.0/test',
		});
		expect(
			ok(
				createPushActivity({
					...base,
					ref: 'refs/heads/main',
					head: 'a'.repeat(40),
				}),
			),
		).toMatchObject({
			pushSourceUrl: `https://github.com/octocat/hello-world/commit/${'a'.repeat(40)}`,
		});
		expect(
			ok(createPushActivity({ ...base, ref: 'refs/other/main' })),
		).not.toHaveProperty('pushSourceUrl');
	});

	it('normalizes controls and escapes the complete punctuation set', () => {
		const punctuation = [
			'!',
			'"',
			'#',
			'$',
			'%',
			'&',
			"'",
			'(',
			')',
			'*',
			'+',
			',',
			'-',
			'.',
			'/',
			':',
			';',
			'<',
			'=',
			'>',
			'?',
			'@',
			'[',
			'\\',
			']',
			'^',
			'_',
			'`',
			'{',
			'|',
			'}',
			'~',
		].join('');
		const escapedPunctuation = punctuation
			.split('')
			.map((character) => `\\${character}`)
			.join('');
		expect(
			normalizeProviderText(
				`a\r\n\t\x7f${punctuation}\u2028\u2029\u061c\u200e\u200f`,
			),
		).toBe('a����' + escapedPunctuation + '�����');
		for (const codePoint of [
			0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
			0x2069,
		]) {
			expect(normalizeProviderText(String.fromCodePoint(codePoint))).toBe(
				'�',
			);
		}
	});

	it('serializes every family with exact wording and hostile text contained', () => {
		const push = ok(
			createPushActivity({ ...base, ref: 'refs/heads/main' }),
		);
		expect(serializeActivityFragment(push)).toBe(
			'Push to [octocat/hello-world](https://github.com/octocat/hello-world) at [refs\\/heads\\/main](https://github.com/octocat/hello-world/tree/main)',
		);
		const linkedPush = ok(
			createPushActivity({
				...base,
				ref: 'refs/heads/main',
				head: 'a'.repeat(40),
			}),
		);
		expect(serializeActivityFragment(linkedPush)).toContain(
			`[refs\\/heads\\/main](https://github.com/octocat/hello-world/commit/${'a'.repeat(40)})`,
		);
		const pull = ok(
			createPullRequestActivity({
				...base,
				number: '4',
				title: '[unsafe] `title`',
				action: 'merged',
			}),
		);
		expect(serializeActivityFragment(pull)).toBe(
			'Pull request [#4](https://github.com/octocat/hello-world/pull/4) merged in [octocat/hello-world](https://github.com/octocat/hello-world): \\[unsafe\\] \\`title\\`',
		);
		const issue = ok(
			createIssueActivity({
				...base,
				number: '5',
				title: 'Fix bug',
				action: 'closed',
			}),
		);
		expect(serializeActivityFragment(issue)).toBe(
			'Issue [#5](https://github.com/octocat/hello-world/issues/5) closed in [octocat/hello-world](https://github.com/octocat/hello-world): Fix bug',
		);
		for (const [action, expected] of [
			[
				'opened',
				'Issue [#5](https://github.com/octocat/hello-world/issues/5) opened in [octocat/hello-world](https://github.com/octocat/hello-world): Fix bug',
			],
			[
				'reopened',
				'Issue [#5](https://github.com/octocat/hello-world/issues/5) reopened in [octocat/hello-world](https://github.com/octocat/hello-world): Fix bug',
			],
			[
				'closed',
				'Issue [#5](https://github.com/octocat/hello-world/issues/5) closed in [octocat/hello-world](https://github.com/octocat/hello-world): Fix bug',
			],
		] as const) {
			const activity = ok(
				createIssueActivity({
					...base,
					number: '5',
					title: 'Fix bug',
					action,
				}),
			);
			expect(serializeActivityFragment(activity)).toBe(expected);
		}
		for (const [action, expected] of [
			[
				'opened',
				'Pull request [#4](https://github.com/octocat/hello-world/pull/4) opened in [octocat/hello-world](https://github.com/octocat/hello-world): Improve docs',
			],
			[
				'reopened',
				'Pull request [#4](https://github.com/octocat/hello-world/pull/4) reopened in [octocat/hello-world](https://github.com/octocat/hello-world): Improve docs',
			],
			[
				'closed',
				'Pull request [#4](https://github.com/octocat/hello-world/pull/4) closed in [octocat/hello-world](https://github.com/octocat/hello-world): Improve docs',
			],
			[
				'merged',
				'Pull request [#4](https://github.com/octocat/hello-world/pull/4) merged in [octocat/hello-world](https://github.com/octocat/hello-world): Improve docs',
			],
		] as const) {
			const activity = ok(
				createPullRequestActivity({
					...base,
					number: '4',
					title: 'Improve docs',
					action,
				}),
			);
			expect(serializeActivityFragment(activity)).toBe(expected);
		}
	});
});
