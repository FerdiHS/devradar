import { describe, expect, it } from 'vitest';
import {
	parsePersonNote,
	renderManagedContent,
	renderManagedSection,
	renderNewPersonNote,
	associatePersonNote,
	replaceManagedContent,
	type PersonIdentity,
	type PersonNoteInspection,
	type PersonNoteResult,
} from '../src/domain/person-note';
import { createIssueActivity, type Activity } from '../src/domain/activity';

const identity: PersonIdentity = { username: 'octocat', githubId: '583231' };
const begin = '<!-- devradar:begin github="octocat" github-id="583231" -->';
const end = '<!-- devradar:end github="octocat" github-id="583231" -->';

const ok = <T>(result: PersonNoteResult<T>): T => {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error('expected successful result');
	return result.value;
};

const activity = (
	providerEventId: string,
	timestamp: string,
	title = 'Fix bug',
): Activity => {
	const result = createIssueActivity({
		providerEventId,
		timestamp,
		repository: 'octocat/hello-world',
		number: '5',
		title,
		action: 'opened',
	});
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
};

const section = (body: string, eol = '\n'): string =>
	[begin, '## DevRadar activity', body, end].join(eol);

const invalidKind = (inspection: PersonNoteInspection): string => {
	expect(inspection.kind).toBe('invalid');
	if (inspection.kind !== 'invalid') throw new Error('expected invalid note');
	return inspection.error.kind;
};

describe('person-note parsing', () => {
	it('recognizes marker-free notes', () => {
		expect(parsePersonNote('# Notes\n\nUser content')).toEqual({
			kind: 'marker-free',
		});
	});

	it('recognizes one valid matching section and preserves marker casing on replacement', () => {
		const note = [
			'# User content',
			'',
			'<!-- devradar:begin github="OctoCat" github-id="583231" -->',
			'## DevRadar activity',
			'',
			'User-edited body',
			'<!-- devradar:end github="OctoCat" github-id="583231" -->',
			'',
			'<!-- unrelated comment -->',
			'After content',
		].join('\n');
		const parsed = parsePersonNote(note, identity);
		expect(parsed.kind).toBe('valid-section');
		const changed = replaceManagedContent(note, identity, []);
		expect(changed.ok).toBe(true);
		if (!changed.ok) return;
		expect(changed.value.markdown).toContain(
			'<!-- devradar:begin github="OctoCat" github-id="583231" -->',
		);
		expect(changed.value.markdown).toContain(
			'<!-- devradar:end github="OctoCat" github-id="583231" -->',
		);
		expect(changed.value.markdown).toContain('<!-- unrelated comment -->');
		expect(changed.value.markdown).toContain('After content');
	});

	it('keeps a valid case-variant section byte-identical on a no-op', () => {
		const note = [
			'<!-- devradar:begin github="OctoCat" github-id="583231" -->',
			'## DevRadar activity',
			'',
			'_No activity recorded by DevRadar yet._',
			'<!-- devradar:end github="OctoCat" github-id="583231" -->',
		].join('\n');
		expect(replaceManagedContent(note, identity, [])).toEqual({
			ok: true,
			value: { markdown: note, changed: false },
		});
	});

	it('allows unrelated HTML comments inside the managed section', () => {
		const note = section('<!-- unrelated comment -->\nUser-edited content');
		expect(parsePersonNote(note, identity)).toMatchObject({
			kind: 'valid-section',
			section: {
				managedContent:
					'## DevRadar activity\n<!-- unrelated comment -->\nUser-edited content\n',
			},
		});
	});

	it('rejects partial, malformed, ambiguous, reversed, and mismatched markers', () => {
		expect(invalidKind(parsePersonNote(begin))).toBe('missing-marker');
		expect(invalidKind(parsePersonNote(end))).toBe('missing-marker');
		expect(invalidKind(parsePersonNote(`${begin}\n${begin}\n${end}`))).toBe(
			'ambiguous-marker',
		);
		expect(invalidKind(parsePersonNote(`${begin}\n${end}\n${end}`))).toBe(
			'ambiguous-marker',
		);
		expect(
			invalidKind(parsePersonNote(`${begin}\n${end}\n${begin}\n${end}`)),
		).toBe('ambiguous-marker');
		expect(invalidKind(parsePersonNote(`${end}\n${begin}`))).toBe(
			'ambiguous-marker',
		);
		expect(
			invalidKind(
				parsePersonNote(`${begin}\n${end.replace('583231', '583232')}`),
			),
		).toBe('identity-mismatch');
		expect(
			parsePersonNote(`${begin}\n${end.replace('octocat', 'hubot')}`),
		).toMatchObject({
			kind: 'invalid',
			error: { kind: 'identity-mismatch', reason: 'begin-end' },
		});
		expect(
			invalidKind(
				parsePersonNote(`${begin}\n${end}`, {
					...identity,
					username: 'hubot',
				}),
			),
		).toBe('identity-mismatch');
	});

	it('classifies nested and multiple complete pairs distinctly', () => {
		const nested = parsePersonNote(`${begin}\n${begin}\n${end}\n${end}`);
		const multiple = parsePersonNote(`${begin}\n${end}\n${begin}\n${end}`);
		expect(nested).toMatchObject({
			kind: 'invalid',
			error: { kind: 'ambiguous-marker', reason: 'nested' },
		});
		expect(multiple).toMatchObject({
			kind: 'invalid',
			error: { kind: 'ambiguous-marker', reason: 'multiple-pairs' },
		});
	});

	it('rejects every reserved marker candidate that is not exact grammar', () => {
		const malformed = [
			` <!-- devradar:begin github="octocat" github-id="583231" -->`,
			`${begin} `,
			'<!-- devradar:begin github=\'octocat\' github-id="583231" -->',
			'<!-- devradar:begin github-id="583231" github="octocat" -->',
			'<!-- devradar:begin github="octocat" github-id="583231" extra="x" -->',
			'<!-- devradar:begin github="octocat" -->',
			'<!-- devradar:begin github="" github-id="583231" -->',
			'<!-- devradar:begin github="octo--cat" github-id="583231" -->',
			'<!-- devradar:begin github="octocat" github-id="01" -->',
			'<!-- devradar:begin github="octocat" github-id="abc" -->',
			'<!-- devradar:end github="octocat" -->',
		];
		for (const candidate of malformed)
			expect(invalidKind(parsePersonNote(candidate))).toBe(
				'malformed-marker',
			);
	});

	it('treats case-variant reserved-looking comments as ordinary content', () => {
		for (const comment of [
			'<!-- devradar:BEGIN github="octocat" github-id="583231" -->',
			'<!-- DEVRADAR:begin github="octocat" github-id="583231" -->',
		])
			expect(parsePersonNote(comment)).toEqual({ kind: 'marker-free' });
	});

	it('rejects unterminated reserved marker candidates for every line ending', () => {
		for (const lineEnding of ['', '\n', '\r\n', '\r']) {
			const note = `Before${lineEnding}<!-- devradar:begin github="octocat" github-id="583231"`;
			expect(invalidKind(parsePersonNote(note))).toBe('malformed-marker');
			const result = associatePersonNote(note, identity, []);
			expect(result.ok).toBe(false);
		}
	});

	it('rejects malformed reserved candidates nested inside a valid section', () => {
		const malformedNested = [
			begin,
			'<!-- devradar:begin github=\'octocat\' github-id="583231" -->',
			end,
		].join('\n');
		expect(invalidKind(parsePersonNote(malformedNested))).toBe(
			'malformed-marker',
		);
	});

	it('rejects reserved candidates hidden inside another HTML comment', () => {
		for (const marker of [begin, end]) {
			const note = `<!-- wrapper ${marker}`;
			expect(invalidKind(parsePersonNote(note))).toBe('malformed-marker');
			expect(associatePersonNote(note, identity, []).ok).toBe(false);
		}
	});

	it('ignores marker-shaped lines in literal Markdown contexts', () => {
		const notes = [
			['```md', begin, 'User-authored example.', end, '```'].join('\n'),
			[
				'<!-- user comment',
				begin,
				'User-authored example.',
				end,
				'-->',
			].join('\n'),
		];
		for (const note of notes) {
			expect(parsePersonNote(note)).toEqual({ kind: 'marker-free' });
			expect(replaceManagedContent(note, identity, [])).toEqual({
				ok: false,
				error: {
					kind: 'missing-marker',
					missing: 'associated-section',
				},
			});
		}
	});

	it('recognizes real markers after closed literal Markdown contexts', () => {
		const prefixes = [
			['```md', begin, 'User-authored example.', end, '```'].join('\n'),
			'<!-- ordinary comment -->',
		];
		const generated = ok(renderManagedSection(identity, [], '\n'));
		for (const prefix of prefixes) {
			const note = `${prefix}\n${section('Old content')}`;
			expect(parsePersonNote(note).kind).toBe('valid-section');
			expect(replaceManagedContent(note, identity, [])).toEqual({
				ok: true,
				value: { markdown: `${prefix}\n${generated}`, changed: true },
			});
		}
	});

	it('rejects foreign identity without authorizing mutation', () => {
		const foreign = section('', '\n').replaceAll('octocat', 'hubot');
		const result = replaceManagedContent(foreign, identity, []);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe('identity-mismatch');
		expect(result).not.toHaveProperty('value');
	});

	it('distinguishes a matching username with a foreign account ID', () => {
		const foreign = [
			'<!-- devradar:begin github="octocat" github-id="583232" -->',
			'## DevRadar activity',
			'',
			'body',
			'<!-- devradar:end github="octocat" github-id="583232" -->',
		].join('\n');
		const result = replaceManagedContent(foreign, identity, []);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error).toMatchObject({ kind: 'identity-mismatch' });
	});

	it('rejects invalid expected identities as structured failures', () => {
		const result = parsePersonNote('plain note', {
			username: 'octocat',
			githubId: '01',
		});
		expect(result).toEqual({
			kind: 'invalid',
			error: { kind: 'invalid-identity', field: 'github-id' },
		});
	});
});

describe('person-note rendering', () => {
	it('renders the exact empty managed section and new-note template', () => {
		expect(ok(renderManagedSection(identity, [], '\n'))).toBe(
			`${begin}\n## DevRadar activity\n\n_No activity recorded by DevRadar yet._\n${end}`,
		);
		expect(ok(renderNewPersonNote(identity))).toBe(
			`# octocat\n\nGitHub: [@octocat](https://github.com/octocat)\n\n${begin}\n## DevRadar activity\n\n_No activity recorded by DevRadar yet._\n${end}`,
		);
	});

	it('renders identical bytes for repeated canonical inputs', () => {
		const activities = [activity('1', '2026-08-18T03:00:00Z')];
		const first = ok(renderManagedSection(identity, activities, '\r\n'));
		const second = ok(renderManagedSection(identity, activities, '\r\n'));
		expect(second).toBe(first);
	});

	it('renders activities newest-first with equal timestamps ordered by event ID', () => {
		const activities = [
			activity('20', '2026-08-18T02:00:00Z', 'event twenty'),
			activity('2', '2026-08-18T02:00:00Z', 'event two'),
			activity('1', '2026-08-18T03:00:00Z'),
		];
		const original = activities.slice();
		const content = renderManagedContent(activities, '\n');
		expect(activities).toEqual(original);
		expect(content).toBe(
			[
				'## DevRadar activity',
				'',
				'- `2026-08-18T03:00:00Z` — Issue [#5](https://github.com/octocat/hello-world/issues/5) opened in [octocat/hello-world](https://github.com/octocat/hello-world): Fix bug',
				'- `2026-08-18T02:00:00Z` — Issue [#5](https://github.com/octocat/hello-world/issues/5) opened in [octocat/hello-world](https://github.com/octocat/hello-world): event two',
				'- `2026-08-18T02:00:00Z` — Issue [#5](https://github.com/octocat/hello-world/issues/5) opened in [octocat/hello-world](https://github.com/octocat/hello-world): event twenty',
			].join('\n'),
		);
		expect(content).not.toContain(
			'_No activity recorded by DevRadar yet._',
		);
	});

	it('keeps hostile provider text inside the managed range', () => {
		const hostile = activity(
			'1',
			'2026-08-18T03:00:00Z',
			'<!-- devradar:begin -->',
		);
		const rendered = ok(renderManagedSection(identity, [hostile], '\n'));
		expect(parsePersonNote(rendered, identity).kind).toBe('valid-section');
		expect(rendered.match(/^<!-- devradar:(begin|end) /gm)).toHaveLength(2);
	});

	it('rejects invalid identities before marker interpolation', () => {
		for (const invalid of [
			{ username: '', githubId: '583231' },
			{ username: 'octo--cat', githubId: '583231' },
			{ username: 'octocat', githubId: '01' },
			{ username: 'octocat', githubId: '0' },
		]) {
			const result = renderManagedSection(invalid, [], '\n');
			expect(result.ok).toBe(false);
		}
	});
});

describe('person-note association and replacement', () => {
	it('appends the minimum EOF separator and uses the first line ending', () => {
		const generated = ok(renderManagedSection(identity, [], '\n'));
		const cases = [
			['content', `content\n\n${generated}`],
			['content\n', `content\n\n${generated}`],
			['content\n\n', `content\n\n${generated}`],
			['content\n\n\n', `content\n\n\n${generated}`],
			['content   ', `content   \n\n${generated}`],
			['content   \n', `content   \n\n${generated}`],
			[
				'first\r\nsecond\n',
				`first\r\nsecond\n\r\n${generated.replaceAll('\n', '\r\n')}`,
			],
			[
				'first\rsecond\r',
				`first\rsecond\r\r${generated.replaceAll('\n', '\r')}`,
			],
			[
				'first\r\nsecond\r\n',
				`first\r\nsecond\r\n\r\n${generated.replaceAll('\n', '\r\n')}`,
			],
			['first\nsecond\r', `first\nsecond\r\n\n${generated}`],
			['first\nsecond   \r', `first\nsecond   \r\n\n${generated}`],
			['first\nsecond\r\r', `first\nsecond\r\r${generated}`],
			['first\nsecond\n\r', `first\nsecond\n\r${generated}`],
		] as const;
		for (const [input, expected] of cases) {
			const result = associatePersonNote(input, identity, []);
			expect(result.ok).toBe(true);
			if (!result.ok) continue;
			expect(result.value.markdown).toBe(expected);
			expect(result.value.markdown.startsWith(input)).toBe(true);
		}
	});

	it('reuses an existing valid section instead of appending another one', () => {
		const existing = section('User-edited content');
		const result = associatePersonNote(existing, identity, []);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.markdown.match(/devradar:begin/g)).toHaveLength(1);
		expect(result.value.markdown.match(/devradar:end/g)).toHaveLength(1);
	});

	it('replaces only managed bytes and reports a no-op', () => {
		const note = `Before\n\n${section('Old content')}\n\nAfter`;
		const changed = replaceManagedContent(note, identity, [
			activity('1', '2026-08-18T03:00:00Z'),
		]);
		expect(changed.ok).toBe(true);
		if (!changed.ok) return;
		expect(changed.value.markdown.startsWith('Before\n\n')).toBe(true);
		expect(changed.value.markdown.endsWith('\n\nAfter')).toBe(true);
		expect(changed.value.markdown).not.toContain('Old content');

		const noop = replaceManagedContent(changed.value.markdown, identity, [
			activity('1', '2026-08-18T03:00:00Z'),
		]);
		expect(noop).toEqual({
			ok: true,
			value: { markdown: changed.value.markdown, changed: false },
		});
	});

	it('replaces an empty managed region and then reports a no-op', () => {
		const note = `${begin}\n${end}`;
		const expected = `${begin}\n## DevRadar activity\n\n_No activity recorded by DevRadar yet._\n${end}`;

		expect(replaceManagedContent(note, identity, [])).toEqual({
			ok: true,
			value: { markdown: expected, changed: true },
		});
		expect(replaceManagedContent(expected, identity, [])).toEqual({
			ok: true,
			value: { markdown: expected, changed: false },
		});
	});

	it('preserves mixed outside line endings while generating with the first one', () => {
		const note = [
			'Before',
			'<!-- devradar:begin github="octocat" github-id="583231" -->',
			'## DevRadar activity',
			'',
			'Old content',
			'<!-- devradar:end github="octocat" github-id="583231" -->',
			'After',
		].join('\r\n');
		const withMixedSuffix = `${note}\nMixed suffix\rTail`;
		const result = replaceManagedContent(withMixedSuffix, identity, []);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const generated = ok(renderManagedSection(identity, [], '\r\n'));
		expect(result.value.markdown).toBe(
			`Before\r\n${generated}\r\nAfter\nMixed suffix\rTail`,
		);
	});

	it('uses the first line ending after an existing begin marker', () => {
		const note = `Before\r\n${begin}\n## DevRadar activity\n\nOld content\n${end}\nAfter`;
		const result = replaceManagedContent(note, identity, []);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const generated = ok(renderManagedSection(identity, [], '\r\n'));
		expect(result.value.markdown).toBe(`Before\r\n${generated}\nAfter`);
	});

	it('supports sections at the beginning and at EOF without owning a trailing newline', () => {
		for (const note of [section('old'), `Before\n\n${section('old')}`]) {
			const result = replaceManagedContent(note, identity, []);
			expect(result.ok).toBe(true);
			if (!result.ok) continue;
			expect(result.value.markdown.endsWith(end)).toBe(true);
			expect(result.value.markdown.endsWith(`${end}\n`)).toBe(false);
		}
	});

	it('fails closed without output for malformed associated notes', () => {
		const result = replaceManagedContent(
			`${begin}\nuser content`,
			identity,
			[],
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe('missing-marker');
	});
});
