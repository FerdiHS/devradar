import {
	canonicalizePositiveNumber,
	canonicalizeRepository,
	canonicalizeTimestamp,
	compareActivities,
	encodePathComponent,
	issueUrl,
	pullRequestUrl,
	repositoryUrl,
	normalizeProviderText,
	serializeActivityFragment,
	validateRef,
	type Activity,
	type CanonicalRepository,
	type CanonicalTimestamp,
} from './activity';
import {
	isCanonicalGitHubUsername,
	isCanonicalPositiveDecimalString,
} from './primitives';

export type LineEnding = '\n' | '\r\n' | '\r';

export interface PersonIdentity {
	readonly username: string;
	readonly githubId: string;
}

export interface ManagedSection {
	readonly identity: PersonIdentity;
	readonly beginMarker: string;
	readonly endMarker: string;
	readonly managedContent: string;
	readonly lineEnding: LineEnding;
}

export interface RetainedActivityEntry {
	readonly timestamp: CanonicalTimestamp;
	readonly markdown: string;
}

export type ManagedActivityEntry =
	| { readonly kind: 'retained'; readonly entry: RetainedActivityEntry }
	| { readonly kind: 'new'; readonly activity: Activity };

export type PersonNoteFailure =
	| {
			readonly kind: 'invalid-identity';
			readonly field: 'username' | 'github-id';
	  }
	| {
			readonly kind: 'missing-marker';
			readonly missing: 'begin' | 'end' | 'associated-section';
	  }
	| {
			readonly kind: 'malformed-marker';
			readonly marker: 'begin' | 'end';
	  }
	| {
			readonly kind: 'ambiguous-marker';
			readonly reason:
				| 'duplicate-begin'
				| 'duplicate-end'
				| 'multiple-pairs'
				| 'nested'
				| 'reversed';
	  }
	| {
			readonly kind: 'identity-mismatch';
			readonly reason: 'begin-end' | 'expected';
			readonly actual?: PersonIdentity;
			readonly expected?: PersonIdentity;
	  };

export type PersonNoteInspection =
	| { readonly kind: 'marker-free' }
	| { readonly kind: 'valid-section'; readonly section: ManagedSection }
	| { readonly kind: 'invalid'; readonly error: PersonNoteFailure };

export type PersonNoteResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: PersonNoteFailure };

export interface PersonNoteChange {
	readonly markdown: string;
	readonly changed: boolean;
}

const MARKER =
	/^<!-- devradar:(begin|end) github="([^"]+)" github-id="([^"]+)" -->$/;

interface NoteLine {
	readonly text: string;
	readonly start: number;
	readonly end: number;
	readonly lineEnding: LineEnding | '';
}

interface MarkerCandidate {
	readonly kind: 'begin' | 'end';
	readonly identity: PersonIdentity;
	readonly marker: string;
	readonly line: NoteLine;
}

interface ParsedSection extends ManagedSection {
	readonly beginMarkerEnd: number;
	readonly contentEnd: number;
}

interface CodeFence {
	readonly character: '`' | '~';
	readonly length: number;
}

interface LiteralMarkdownScan {
	readonly lineStarts: ReadonlySet<number>;
	readonly unterminated: boolean;
}

const success = <T>(value: T): PersonNoteResult<T> => ({ ok: true, value });

const failure = <T>(error: PersonNoteFailure): PersonNoteResult<T> => ({
	ok: false,
	error,
});

function invalid(error: PersonNoteFailure): PersonNoteInspection {
	return { kind: 'invalid', error };
}

function validateIdentity(input: unknown): PersonNoteFailure | undefined {
	if (
		!input ||
		typeof input !== 'object' ||
		!isCanonicalGitHubUsername((input as { username?: unknown }).username)
	)
		return { kind: 'invalid-identity', field: 'username' };
	if (
		!isCanonicalPositiveDecimalString(
			(input as { githubId?: unknown }).githubId,
		)
	)
		return { kind: 'invalid-identity', field: 'github-id' };
	return undefined;
}

function copyIdentity(input: PersonIdentity): PersonIdentity {
	return { username: input.username, githubId: input.githubId };
}

function identitiesMatch(left: PersonIdentity, right: PersonIdentity): boolean {
	return (
		left.username.toLowerCase() === right.username.toLowerCase() &&
		left.githubId === right.githubId
	);
}

function splitLines(input: string): NoteLine[] {
	const lines: NoteLine[] = [];
	let start = 0;
	let index = 0;
	while (index < input.length) {
		const character = input[index];
		if (character !== '\r' && character !== '\n') {
			index += 1;
			continue;
		}
		const lineEnding =
			character === '\r' && input[index + 1] === '\n'
				? '\r\n'
				: character;
		lines.push({
			text: input.slice(start, index),
			start,
			end: index,
			lineEnding,
		});
		index += lineEnding.length;
		start = index;
	}
	if (start < input.length || lines.length === 0)
		lines.push({
			text: input.slice(start),
			start,
			end: input.length,
			lineEnding: '',
		});
	return lines;
}

function lineAt(
	lines: readonly NoteLine[],
	start: number,
): NoteLine | undefined {
	return lines.find((line) => line.start <= start && start <= line.end);
}

function markerKind(body: string): 'begin' | 'end' | undefined {
	const trimmed = body.trim();
	if (trimmed.startsWith('devradar:begin')) return 'begin';
	if (trimmed.startsWith('devradar:end')) return 'end';
	return undefined;
}

function openingFence(line: string): CodeFence | undefined {
	const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
	if (!match) return undefined;
	const fence = match[2];
	if (!fence || (fence[0] === '`' && match[3]?.includes('`')))
		return undefined;
	return { character: fence[0] as '`' | '~', length: fence.length };
}

function closesFence(line: string, fence: CodeFence): boolean {
	return new RegExp(
		`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`,
	).test(line);
}

function scanLiteralMarkdown(lines: readonly NoteLine[]): LiteralMarkdownScan {
	const literal = new Set<number>();
	let fence: CodeFence | undefined;
	let htmlCommentOpen = false;
	for (const line of lines) {
		if (fence) {
			literal.add(line.start);
			if (closesFence(line.text, fence)) fence = undefined;
			continue;
		}
		if (htmlCommentOpen) {
			literal.add(line.start);
			if (line.text.includes('-->')) htmlCommentOpen = false;
			continue;
		}
		const nextFence = openingFence(line.text);
		if (nextFence) {
			literal.add(line.start);
			fence = nextFence;
			continue;
		}
		const commentStart = /^ {0,3}<!--/.test(line.text)
			? line.text.indexOf('<!--')
			: -1;
		if (
			commentStart !== -1 &&
			line.text.indexOf('-->', commentStart + 4) === -1
		)
			htmlCommentOpen = true;
	}
	return {
		lineStarts: literal,
		unterminated: Boolean(fence || htmlCommentOpen),
	};
}

function scanMarkers(
	input: string,
	lines: readonly NoteLine[],
): {
	readonly candidates: readonly MarkerCandidate[];
	readonly unterminated: boolean;
	readonly malformed?: PersonNoteFailure;
} {
	const candidates: MarkerCandidate[] = [];
	const literalScan = scanLiteralMarkdown(lines);
	let malformed: PersonNoteFailure | undefined;
	for (const match of input.matchAll(/<!--/g)) {
		const start = match.index ?? 0;
		const line = lineAt(lines, start);
		if (line && literalScan.lineStarts.has(line.start)) continue;
		const close = input.indexOf('-->', start + 4);
		const raw =
			close === -1 ? input.slice(start) : input.slice(start, close + 3);
		const body = input.slice(
			start + 4,
			close === -1 ? input.length : close,
		);
		const kind = markerKind(body);
		if (!kind) continue;
		const parsed =
			close !== -1 && line?.text === raw && line.start === start
				? MARKER.exec(raw)
				: null;
		if (!parsed || parsed[1] !== kind) {
			malformed ??= { kind: 'malformed-marker', marker: kind };
			continue;
		}
		const username = parsed[2];
		const githubId = parsed[3];
		if (
			!username ||
			!githubId ||
			!isCanonicalGitHubUsername(username) ||
			!isCanonicalPositiveDecimalString(githubId)
		) {
			malformed ??= { kind: 'malformed-marker', marker: kind };
			continue;
		}
		if (!line) {
			malformed ??= { kind: 'malformed-marker', marker: kind };
			continue;
		}
		candidates.push({
			kind,
			identity: { username, githubId },
			marker: raw,
			line,
		});
	}
	return {
		candidates,
		unterminated: literalScan.unterminated,
		...(malformed ? { malformed } : {}),
	};
}

function detectLineEnding(input: string): LineEnding {
	for (let index = 0; index < input.length; index += 1) {
		if (input[index] === '\r')
			return input[index + 1] === '\n' ? '\r\n' : '\r';
		if (input[index] === '\n') return '\n';
	}
	return '\n';
}

function trailingLineEndingCount(input: string): number {
	let index = input.length;
	let count = 0;
	while (index > 0) {
		if (index >= 2 && input.slice(index - 2, index) === '\r\n') {
			count += 1;
			index -= 2;
		} else if (input[index - 1] === '\r' || input[index - 1] === '\n') {
			count += 1;
			index -= 1;
		} else break;
	}
	return count;
}

function markerText(kind: 'begin' | 'end', identity: PersonIdentity): string {
	return `<!-- devradar:${kind} github="${identity.username}" github-id="${identity.githubId}" -->`;
}

function asParsedSection(
	beginCandidate: MarkerCandidate,
	endCandidate: MarkerCandidate,
	input: string,
): ParsedSection {
	const lineEnding = detectLineEnding(input);
	const contentStart =
		beginCandidate.line.end + beginCandidate.line.lineEnding.length;
	const contentEnd = endCandidate.line.start;
	return {
		identity: copyIdentity(beginCandidate.identity),
		beginMarker: beginCandidate.marker,
		endMarker: endCandidate.marker,
		managedContent: input.slice(contentStart, contentEnd),
		lineEnding,
		beginMarkerEnd: beginCandidate.line.end,
		contentEnd,
	};
}

export function parsePersonNote(
	input: string,
	expectedIdentity?: PersonIdentity,
): PersonNoteInspection {
	const identityError = expectedIdentity
		? validateIdentity(expectedIdentity)
		: undefined;
	if (identityError) return invalid(identityError);
	const lines = splitLines(input);
	const { candidates, malformed, unterminated } = scanMarkers(input, lines);
	if (malformed) return invalid(malformed);
	if (candidates.length === 0) {
		if (unterminated)
			return invalid({
				kind: 'missing-marker',
				missing: 'associated-section',
			});
		return { kind: 'marker-free' };
	}

	const begins = candidates.filter((candidate) => candidate.kind === 'begin');
	const ends = candidates.filter((candidate) => candidate.kind === 'end');
	if (begins.length > 1 && ends.length > 1) {
		const orderedBegins = begins
			.slice()
			.sort((left, right) => left.line.start - right.line.start);
		const orderedEnds = ends
			.slice()
			.sort((left, right) => left.line.start - right.line.start);
		const secondBegin = orderedBegins[1];
		const firstEnd = orderedEnds[0];
		const secondEnd = orderedEnds[1];
		if (
			secondBegin &&
			firstEnd &&
			secondEnd &&
			secondBegin.line.start < firstEnd.line.start &&
			firstEnd.line.start < secondEnd.line.start
		)
			return invalid({ kind: 'ambiguous-marker', reason: 'nested' });
		return invalid({ kind: 'ambiguous-marker', reason: 'multiple-pairs' });
	}
	if (begins.length > 1)
		return invalid({ kind: 'ambiguous-marker', reason: 'duplicate-begin' });
	if (ends.length > 1)
		return invalid({ kind: 'ambiguous-marker', reason: 'duplicate-end' });
	if (begins.length === 0)
		return invalid({ kind: 'missing-marker', missing: 'begin' });
	if (ends.length === 0)
		return invalid({ kind: 'missing-marker', missing: 'end' });

	const beginCandidate = begins[0];
	const endCandidate = ends[0];
	if (!beginCandidate || !endCandidate)
		return invalid({
			kind: 'missing-marker',
			missing: 'associated-section',
		});
	if (beginCandidate.line.start > endCandidate.line.start)
		return invalid({ kind: 'ambiguous-marker', reason: 'reversed' });
	if (!identitiesMatch(beginCandidate.identity, endCandidate.identity))
		return invalid({
			kind: 'identity-mismatch',
			reason: 'begin-end',
			actual: copyIdentity(endCandidate.identity),
			expected: copyIdentity(beginCandidate.identity),
		});
	if (
		expectedIdentity &&
		!identitiesMatch(beginCandidate.identity, expectedIdentity)
	)
		return invalid({
			kind: 'identity-mismatch',
			reason: 'expected',
			actual: copyIdentity(beginCandidate.identity),
			expected: copyIdentity(expectedIdentity),
		});
	return {
		kind: 'valid-section',
		section: asParsedSection(beginCandidate, endCandidate, input),
	};
}

export function renderManagedContent(
	activities: readonly Activity[],
	lineEnding: LineEnding,
): string {
	return renderManagedEntries(
		activities
			.slice()
			.sort(compareActivities)
			.map((activity) => ({ kind: 'new' as const, activity })),
		lineEnding,
	);
}

export function renderActivityEntry(activity: Activity): string {
	return `- \`${activity.timestamp}\` — ${serializeActivityFragment(activity)}`;
}

export function renderManagedEntries(
	entries: readonly ManagedActivityEntry[],
	lineEnding: LineEnding,
): string {
	const lines = ['## DevRadar activity', ''];
	if (entries.length === 0)
		lines.push('_No activity recorded by DevRadar yet._');
	else
		lines.push(
			...entries.map((entry) =>
				entry.kind === 'retained'
					? entry.entry.markdown
					: renderActivityEntry(entry.activity),
			),
		);
	return lines.join(lineEnding);
}

const CANONICAL_PUNCTUATION = new Set(
	Array.from('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'),
);

interface MarkdownLink {
	readonly label: string;
	readonly url: string;
	readonly end: number;
}

function readMarkdownLink(
	input: string,
	start: number,
): MarkdownLink | undefined {
	if (input[start] !== '[') return undefined;
	let index = start + 1;
	let label = '';
	while (index < input.length) {
		const character = input[index];
		if (character === '\\' && index + 1 < input.length) {
			label += character + input[index + 1];
			index += 2;
			continue;
		}
		if (character === ']' && input[index + 1] === '(') break;
		label += character;
		index += 1;
	}
	if (input[index] !== ']' || input[index + 1] !== '(') return undefined;
	const urlStart = index + 2;
	const close = input.indexOf(')', urlStart);
	if (close === -1) return undefined;
	return {
		label,
		url: input.slice(urlStart, close),
		end: close + 1,
	};
}

function isCanonicalProviderText(input: string): boolean {
	if (input.length === 0) return false;
	for (let index = 0; index < input.length; index += 1) {
		const character = input[index];
		if (!character) return false;
		const codeUnit = character.charCodeAt(0);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = input.charCodeAt(index + 1);
			if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff)
				return false;
			index += 1;
			continue;
		}
		if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
		const code = character.codePointAt(0) ?? 0;
		if (
			(code >= 0 && code <= 0x1f) ||
			code === 0x7f ||
			code === 0x2028 ||
			code === 0x2029 ||
			code === 0x061c ||
			code === 0x200e ||
			code === 0x200f ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		)
			return false;
		if (character === '\\') {
			const escaped = input[index + 1];
			if (!escaped || !CANONICAL_PUNCTUATION.has(escaped)) return false;
			index += 1;
			continue;
		}
		if (CANONICAL_PUNCTUATION.has(character)) return false;
	}
	return true;
}

function decodeProviderText(input: string): string {
	let decoded = '';
	for (let index = 0; index < input.length; index += 1) {
		if (input[index] === '\\' && index + 1 < input.length) {
			decoded += input[index + 1];
			index += 1;
		} else decoded += input[index] ?? '';
	}
	return decoded;
}

function decodeCanonicalPath(input: string): string | undefined {
	const segments = input.split('/');
	if (segments.some((segment) => segment.length === 0)) return undefined;
	let decoded: string[];
	try {
		decoded = segments.map((segment) => decodeURIComponent(segment));
	} catch {
		return undefined;
	}
	if (decoded.map(encodePathComponent).join('/') !== input) return undefined;
	return decoded.join('/');
}

function canonicalTreeRef(
	link: MarkdownLink,
	label: string,
	repository: CanonicalRepository,
): string | undefined {
	const displayedRef = decodeProviderText(label);
	const prefix = displayedRef.startsWith('refs/heads/')
		? 'refs/heads/'
		: displayedRef.startsWith('refs/tags/')
			? 'refs/tags/'
			: undefined;
	if (!prefix) return undefined;
	const treeUrlPrefix = `${repositoryUrl(repository)}/tree/`;
	if (!link.url.startsWith(treeUrlPrefix)) return undefined;
	const suffix = decodeCanonicalPath(link.url.slice(treeUrlPrefix.length));
	if (suffix === undefined) return undefined;
	const ref = `${prefix}${suffix}`;
	if (!validateRef(ref).ok) return undefined;
	const expectedUrl = `${treeUrlPrefix}${ref
		.slice(prefix.length)
		.split('/')
		.map(encodePathComponent)
		.join('/')}`;
	return expectedUrl === link.url && normalizeProviderText(ref) === label
		? ref
		: undefined;
}

function canonicalRepositoryLink(
	input: string,
	start: number,
):
	| { readonly repository: CanonicalRepository; readonly end: number }
	| undefined {
	const link = readMarkdownLink(input, start);
	if (!link) return undefined;
	const repository = canonicalizeRepository(link.label);
	if (!repository.ok || link.url !== repositoryUrl(repository.value))
		return undefined;
	return { repository: repository.value, end: link.end };
}

function canonicalObjectFragment(
	input: string,
	family: 'pull-request' | 'issue',
): boolean {
	const prefix = family === 'pull-request' ? 'Pull request ' : 'Issue ';
	if (!input.startsWith(prefix)) return false;
	const numberLink = readMarkdownLink(input, prefix.length);
	if (!numberLink || !numberLink.label.startsWith('#')) return false;
	const number = canonicalizePositiveNumber(numberLink.label.slice(1));
	if (!number.ok) return false;
	if (input[numberLink.end] !== ' ') return false;
	const actionStart = numberLink.end + 1;
	const actions =
		family === 'pull-request'
			? ['opened', 'reopened', 'closed', 'merged']
			: ['opened', 'reopened', 'closed'];
	const action = actions.find((candidate) =>
		input.startsWith(`${candidate} in `, actionStart),
	);
	if (!action) return false;
	const repositoryStart = actionStart + action.length + 4;
	const repositoryLink = canonicalRepositoryLink(input, repositoryStart);
	if (!repositoryLink) return false;
	const expectedUrl =
		family === 'pull-request'
			? pullRequestUrl(repositoryLink.repository, number.value)
			: issueUrl(repositoryLink.repository, number.value);
	if (numberLink.url !== expectedUrl) return false;
	if (!input.startsWith(': ', repositoryLink.end)) return false;
	const title = input.slice(repositoryLink.end + 2);
	return title.length > 0 && isCanonicalProviderText(title);
}

function canonicalPushFragment(input: string): boolean {
	if (!input.startsWith('Push to ')) return false;
	const repositoryLink = canonicalRepositoryLink(input, 'Push to '.length);
	if (!repositoryLink || !input.startsWith(' at ', repositoryLink.end))
		return false;
	const valueStart = repositoryLink.end + 4;
	const value = input.slice(valueStart);
	if (value.startsWith('[')) {
		const link = readMarkdownLink(value, 0);
		if (
			!link ||
			link.end !== value.length ||
			!isCanonicalProviderText(link.label)
		)
			return false;
		const displayedRef = decodeProviderText(link.label);
		if (
			!validateRef(displayedRef).ok ||
			normalizeProviderText(displayedRef) !== link.label
		)
			return false;
		const treeRef = canonicalTreeRef(
			link,
			link.label,
			repositoryLink.repository,
		);
		const commitPrefix = `${repositoryUrl(repositoryLink.repository)}/commit/`;
		const commitId = link.url.startsWith(commitPrefix)
			? link.url.slice(commitPrefix.length)
			: undefined;
		return (
			treeRef !== undefined ||
			(commitId !== undefined && /^[0-9a-f]{40}$/.test(commitId))
		);
	}
	const ref = decodeProviderText(value);
	return (
		isCanonicalProviderText(value) &&
		!ref.startsWith('refs/heads/') &&
		!ref.startsWith('refs/tags/') &&
		validateRef(ref).ok
	);
}

function isCanonicalActivityFragment(input: string): boolean {
	return (
		canonicalPushFragment(input) ||
		canonicalObjectFragment(input, 'pull-request') ||
		canonicalObjectFragment(input, 'issue')
	);
}

export function parseCanonicalActivityEntries(
	managedContent: string,
): readonly RetainedActivityEntry[] {
	const entries: RetainedActivityEntry[] = [];
	const lines = splitLines(managedContent);
	const literalScan = scanLiteralMarkdown(lines);
	for (const line of lines) {
		if (literalScan.lineStarts.has(line.start)) continue;
		const match = /^- `([^`\r\n]+)` — (.+)$/.exec(line.text);
		if (!match) continue;
		const timestampText = match[1];
		const fragment = match[2];
		if (timestampText === undefined || fragment === undefined) continue;
		const timestamp = canonicalizeTimestamp(timestampText);
		if (
			!timestamp.ok ||
			timestamp.value !== timestampText ||
			!isCanonicalActivityFragment(fragment)
		)
			continue;
		entries.push({ timestamp: timestamp.value, markdown: line.text });
	}
	return entries;
}

export function renderManagedSection(
	identity: PersonIdentity,
	activities: readonly Activity[],
	lineEnding: LineEnding,
): PersonNoteResult<string> {
	const identityError = validateIdentity(identity);
	if (identityError) return failure(identityError);
	const body = renderManagedContent(activities, lineEnding);
	return success(
		[markerText('begin', identity), body, markerText('end', identity)].join(
			lineEnding,
		),
	);
}

export function renderNewPersonNote(
	identity: PersonIdentity,
	activities: readonly Activity[] = [],
): PersonNoteResult<string> {
	const rendered = renderManagedSection(identity, activities, '\n');
	if (!rendered.ok) return rendered;
	return success(
		`# ${identity.username}\n\nGitHub: [@${identity.username}](https://github.com/${identity.username})\n\n${rendered.value}`,
	);
}

function replaceParsedSection(
	input: string,
	section: ParsedSection,
	activities: readonly Activity[],
): PersonNoteResult<PersonNoteChange> {
	const body = renderManagedContent(activities, section.lineEnding);
	const markdown =
		input.slice(0, section.beginMarkerEnd) +
		section.lineEnding +
		body +
		section.lineEnding +
		input.slice(section.contentEnd);
	return success({ markdown, changed: markdown !== input });
}

export function replaceManagedContent(
	input: string,
	expectedIdentity: PersonIdentity,
	activities: readonly Activity[],
): PersonNoteResult<PersonNoteChange> {
	const parsed = parsePersonNote(input, expectedIdentity);
	if (parsed.kind === 'invalid') return failure(parsed.error);
	if (parsed.kind === 'marker-free')
		return failure({
			kind: 'missing-marker',
			missing: 'associated-section',
		});
	return replaceParsedSection(
		input,
		parsed.section as ParsedSection,
		activities,
	);
}

export function associatePersonNote(
	input: string,
	identity: PersonIdentity,
	activities: readonly Activity[],
): PersonNoteResult<PersonNoteChange> {
	const parsed = parsePersonNote(input, identity);
	if (parsed.kind === 'invalid') return failure(parsed.error);
	if (parsed.kind === 'valid-section')
		return replaceParsedSection(
			input,
			parsed.section as ParsedSection,
			activities,
		);

	const lineEnding = detectLineEnding(input);
	const rendered = renderManagedSection(identity, activities, lineEnding);
	if (!rendered.ok) return rendered;
	let separatorCount = 0;
	while (
		separatorCount < 2 &&
		trailingLineEndingCount(input + lineEnding.repeat(separatorCount)) < 2
	)
		separatorCount += 1;
	const markdown = input + lineEnding.repeat(separatorCount) + rendered.value;
	return success({ markdown, changed: markdown !== input });
}
