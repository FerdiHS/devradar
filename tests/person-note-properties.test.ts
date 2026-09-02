import { describe, expect, it } from 'vitest';
import {
	inspectAssociationProperties,
	validateAssociationPropertyObject,
} from '../src/domain/person-note-properties';

const identity = { username: 'octocat', githubId: '583231' } as const;

describe('person-note association Properties', () => {
	it('reports both keys as missing without frontmatter', () => {
		expect(inspectAssociationProperties('# octocat', identity)).toEqual({
			ok: true,
			value: {
				missing: ['devradarGithubId', 'devradarGithubUsername'],
			},
		});
	});

	it('treats empty frontmatter as valid with both keys missing', () => {
		expect(
			inspectAssociationProperties('---\n---\n\n# octocat', identity),
		).toEqual({
			ok: true,
			value: { missing: ['devradarGithubId', 'devradarGithubUsername'] },
		});
	});

	it('accepts matching string values and case-insensitive usernames', () => {
		expect(
			inspectAssociationProperties(
				'---\ndevradarGithubId: "583231"\ndevradarGithubUsername: "OctoCat"\n---\n\n# octocat',
				identity,
			),
		).toEqual({ ok: true, value: { missing: [] } });
	});

	it.each([
		'devradarGithubId: 583231',
		'devradarGithubUsername: [octocat]',
		'devradarGithubId: "583230"',
		'devradarGithubUsername: "other"',
	])('rejects invalid reserved values: %s', (property) => {
		expect(
			inspectAssociationProperties(`---\n${property}\n---\n`, identity),
		).toMatchObject({
			ok: false,
			error: { kind: 'frontmatter-failure' },
		});
	});

	it('rejects duplicate and case-colliding reserved keys', () => {
		expect(
			inspectAssociationProperties(
				'---\ndevradarGithubId: "583231"\ndevradargithubid: "583231"\n---\n',
				identity,
			),
		).toEqual({
			ok: false,
			error: {
				kind: 'frontmatter-failure',
				reason: 'reserved-key-variant',
			},
		});
	});

	it('rejects malformed and unsupported YAML', () => {
		expect(
			inspectAssociationProperties('---\nfoo: [\n---\n', identity),
		).toMatchObject({
			ok: false,
			error: { kind: 'frontmatter-failure' },
		});
		expect(
			inspectAssociationProperties(
				'---\nfoo: &value bar\nother: *value\n---\n',
				identity,
			),
		).toEqual({
			ok: false,
			error: {
				kind: 'frontmatter-failure',
				reason: 'unsupported-construct',
			},
		});
	});

	it('rejects BOM-prefixed malformed frontmatter', () => {
		expect(
			inspectAssociationProperties('\uFEFF---\nfoo: bar', identity),
		).toEqual({
			ok: false,
			error: { kind: 'frontmatter-failure', reason: 'malformed' },
		});
	});

	it('returns only missing canonical keys for frontmatter objects', () => {
		expect(
			validateAssociationPropertyObject(
				{ devradarGithubId: '583231', title: 'Example' },
				identity,
			),
		).toEqual({ ok: true, value: { missing: ['devradarGithubUsername'] } });
	});
});
