import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import {
	type PersonIdentity,
	type PersonNoteFailure,
	type PersonNoteResult,
} from './person-note';

export type ReservedAssociationProperty =
	'devradarGithubId' | 'devradarGithubUsername';

export type AssociationPropertyPlan = {
	readonly missing: readonly ReservedAssociationProperty[];
};

const RESERVED = [
	'devradarGithubId',
	'devradarGithubUsername',
] as const satisfies readonly ReservedAssociationProperty[];

const propertyName = {
	devradarGithubId: 'github-id',
	devradarGithubUsername: 'github-username',
} as const;

const success = <T>(value: T): PersonNoteResult<T> => ({ ok: true, value });
const failure = <T>(error: PersonNoteFailure): PersonNoteResult<T> => ({
	ok: false,
	error,
});

function frontmatterFailure(
	reason: Extract<
		PersonNoteFailure,
		{ kind: 'frontmatter-failure' }
	>['reason'],
	property?: 'github-id' | 'github-username',
): PersonNoteFailure {
	return { kind: 'frontmatter-failure', reason, property };
}

function canonicalKey(value: unknown): ReservedAssociationProperty | undefined {
	return typeof value === 'string' &&
		RESERVED.includes(value as ReservedAssociationProperty)
		? (value as ReservedAssociationProperty)
		: undefined;
}

function collidesWithReserved(value: unknown): boolean {
	return (
		typeof value === 'string' &&
		RESERVED.some(
			(reserved) => reserved.toLowerCase() === value.toLowerCase(),
		)
	);
}

function inspectNode(node: unknown): PersonNoteFailure | undefined {
	if (isAlias(node)) return frontmatterFailure('unsupported-construct');
	if (isScalar(node)) {
		if (node.anchor) return frontmatterFailure('unsupported-construct');
		return undefined;
	}
	if (isSeq(node)) {
		if (node.anchor) return frontmatterFailure('unsupported-construct');
		for (const child of node.items) {
			const error = inspectNode(child);
			if (error) return error;
		}
		return undefined;
	}
	if (isMap(node)) {
		if (node.anchor) return frontmatterFailure('unsupported-construct');
		for (const item of node.items) {
			if (item.key && isScalar(item.key) && item.key.value === '<<')
				return frontmatterFailure('unsupported-construct');
			const keyError = inspectNode(item.key);
			if (keyError) return keyError;
			const valueError = inspectNode(item.value);
			if (valueError) return valueError;
		}
	}
	return undefined;
}

function planFromObject(
	frontmatter: Readonly<Record<string, unknown>>,
	identity: PersonIdentity,
): PersonNoteResult<AssociationPropertyPlan> {
	const keys = Object.keys(frontmatter);
	for (const key of keys) {
		if (!collidesWithReserved(key)) continue;
		if (!canonicalKey(key))
			return failure(frontmatterFailure('reserved-key-variant'));
	}
	for (const key of RESERVED) {
		const value = frontmatter[key];
		if (value === undefined) continue;
		if (typeof value !== 'string')
			return failure(
				frontmatterFailure('invalid-property', propertyName[key]),
			);
		if (
			(key === 'devradarGithubId' && value !== identity.githubId) ||
			(key === 'devradarGithubUsername' &&
				value.toLowerCase() !== identity.username.toLowerCase())
		)
			return failure(
				frontmatterFailure('invalid-property', propertyName[key]),
			);
	}
	return success({
		missing: RESERVED.filter((key) => !(key in frontmatter)),
	});
}

export function validateAssociationPropertyObject(
	frontmatter: Readonly<Record<string, unknown>>,
	identity: PersonIdentity,
): PersonNoteResult<AssociationPropertyPlan> {
	return planFromObject(frontmatter, identity);
}

function extractFrontmatter(
	markdown: string,
):
	| { readonly kind: 'none' }
	| { readonly kind: 'invalid'; readonly error: PersonNoteFailure }
	| { readonly kind: 'yaml'; readonly source: string } {
	if (/^(?:\uFEFF)?---(?:\r\n|\r|\n)---(?:(?:\r\n|\r|\n)|$)/.test(markdown))
		return { kind: 'yaml', source: '' };
	const match =
		/^(?:\uFEFF)?---(?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n)---(?:(?:\r\n|\r|\n)|$)/.exec(
			markdown,
		);
	if (!match)
		return markdown.startsWith('---')
			? { kind: 'invalid', error: frontmatterFailure('malformed') }
			: { kind: 'none' };
	return { kind: 'yaml', source: match[1] ?? '' };
}

export function inspectAssociationProperties(
	markdown: string,
	identity: PersonIdentity,
): PersonNoteResult<AssociationPropertyPlan> {
	const extracted = extractFrontmatter(markdown);
	if (extracted.kind === 'none') return planFromObject({}, identity);
	if (extracted.kind === 'invalid') return failure(extracted.error);
	let document: ReturnType<typeof parseDocument>;
	try {
		document = parseDocument(extracted.source, {
			strict: true,
			uniqueKeys: true,
		});
	} catch {
		return failure(frontmatterFailure('malformed'));
	}
	if (document.errors.length > 0 || document.warnings.length > 0)
		return failure(frontmatterFailure('malformed'));
	const nodeError = inspectNode(document.contents);
	if (nodeError) return failure(nodeError);
	if (!document.contents) return planFromObject({}, identity);
	if (!isMap(document.contents))
		return failure(frontmatterFailure('malformed'));
	for (const item of document.contents.items) {
		const key = isScalar(item.key) ? item.key.value : undefined;
		if (collidesWithReserved(key) && !canonicalKey(key))
			return failure(frontmatterFailure('reserved-key-variant'));
	}
	try {
		const value: unknown = document.toJS() as unknown;
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return failure(frontmatterFailure('malformed'));
		return planFromObject(value as Record<string, unknown>, identity);
	} catch {
		return failure(frontmatterFailure('malformed'));
	}
}
