import {
	isCanonicalGitHubUsername,
	isCanonicalPositiveDecimalString,
} from './primitives';

export type ActivityFamily =
	'push' | 'pull-request' | 'pull-request-review' | 'issue' | 'comment';
export type PullRequestAction = 'opened' | 'reopened' | 'closed' | 'merged';
export type IssueAction = 'opened' | 'reopened' | 'closed';
export type CommentAction =
	'issue-comment' | 'review-comment' | 'commit-comment';

export const ACTIVITY_FAMILIES = [
	'push',
	'pull-request',
	'pull-request-review',
	'issue',
	'comment',
] as const satisfies readonly ActivityFamily[];

type Brand<Name extends string> = string & { readonly __brand: Name };
export type CanonicalEventId = Brand<'event-id'>;
export type CanonicalRepository = Brand<'repository'>;
export type CanonicalNumber = Brand<'positive-number'>;
export type CanonicalTimestamp = Brand<'timestamp'>;
export type CanonicalRef = Brand<'ref'>;
export type CanonicalCommitId = Brand<'commit-id'>;

export interface ValidationError {
	readonly code: string;
	readonly message: string;
}

export type ValidationResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: ValidationError };

const success = <T>(value: T): ValidationResult<T> => ({ ok: true, value });
const failure = <T>(code: string, message: string): ValidationResult<T> => ({
	ok: false,
	error: { code, message },
});

const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const COMMIT = /^[0-9a-fA-F]{40}$/;

function containsForbiddenControl(input: string): boolean {
	return Array.from(input).some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return (code >= 0 && code <= 0x1f) || code === 0x7f;
	});
}

function containsUnpairedSurrogate(input: string): boolean {
	for (let index = 0; index < input.length; index += 1) {
		const code = input.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = input.charCodeAt(index + 1);
			if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff)
				return true;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

export function canonicalizeEventId(
	input: string | number,
): ValidationResult<CanonicalEventId> {
	if (typeof input === 'number') {
		if (!Number.isSafeInteger(input) || input <= 0)
			return failure(
				'invalid-event-id',
				'event ID must be a positive safe integer',
			);
		return success(String(input) as CanonicalEventId);
	}
	if (typeof input !== 'string')
		return failure(
			'invalid-event-id',
			'event ID must be a positive decimal string without leading zeroes',
		);
	if (!isCanonicalPositiveDecimalString(input))
		return failure(
			'invalid-event-id',
			'event ID must be a positive decimal string without leading zeroes',
		);
	return success(input as CanonicalEventId);
}

export function canonicalizePositiveNumber(
	input: string | number,
): ValidationResult<CanonicalNumber> {
	if (typeof input === 'number') {
		if (!Number.isSafeInteger(input) || input <= 0)
			return failure(
				'invalid-number',
				'number must be a positive safe integer',
			);
		return success(String(input) as CanonicalNumber);
	}
	if (typeof input !== 'string')
		return failure(
			'invalid-number',
			'number must be a positive decimal string without leading zeroes',
		);
	if (!isCanonicalPositiveDecimalString(input))
		return failure(
			'invalid-number',
			'number must be a positive decimal string without leading zeroes',
		);
	return success(input as CanonicalNumber);
}

export function canonicalizeRepository(
	input: unknown,
): ValidationResult<CanonicalRepository> {
	if (typeof input !== 'string')
		return failure(
			'invalid-repository',
			'repository must be a canonical owner/repository identity',
		);
	const parts = input.split('/');
	const [owner, repository] = parts;
	if (
		parts.length !== 2 ||
		owner === undefined ||
		repository === undefined ||
		!isCanonicalGitHubUsername(owner) ||
		!REPOSITORY.test(repository) ||
		parts.some((part) => part === '.' || part === '..') ||
		containsForbiddenControl(input) ||
		containsUnpairedSurrogate(input) ||
		/%2f|%5c/i.test(input)
	) {
		return failure(
			'invalid-repository',
			'repository must be a canonical owner/repository identity',
		);
	}
	return success(input as CanonicalRepository);
}

export function validateRef(input: unknown): ValidationResult<CanonicalRef> {
	if (typeof input !== 'string')
		return failure('invalid-ref', 'ref is not a supported Git ref');
	if (
		!input ||
		containsForbiddenControl(input) ||
		input.includes('\\') ||
		containsUnpairedSurrogate(input) ||
		/[ ~^:?*\x5b]/.test(input) ||
		input === '@' ||
		input.includes('..') ||
		input.includes('@{') ||
		input.startsWith('/') ||
		input.endsWith('/') ||
		input
			.split('/')
			.some(
				(part) =>
					!part ||
					part.startsWith('.') ||
					/\.lock$/.test(part) ||
					part.endsWith('.'),
			)
	) {
		return failure('invalid-ref', 'ref is not a supported Git ref');
	}
	return success(input as CanonicalRef);
}

export function validateCommitId(
	input: unknown,
): ValidationResult<CanonicalCommitId> {
	if (typeof input !== 'string')
		return failure(
			'invalid-commit-id',
			'commit ID must be 40 hexadecimal characters',
		);
	return COMMIT.test(input)
		? success(input.toLowerCase() as CanonicalCommitId)
		: failure(
				'invalid-commit-id',
				'commit ID must be 40 hexadecimal characters',
			);
}

const TIMESTAMP =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
	if (month === 2)
		return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
			? 29
			: 28;
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function timestampParts(
	value: unknown,
): { epoch: number; fraction: string } | undefined {
	if (typeof value !== 'string') return undefined;
	const match = TIMESTAMP.exec(value);
	if (!match) return undefined;
	const [, year, month, day, hour, minute, second, rawFraction = '', zone] =
		match;
	if (!zone) return undefined;
	const numericYear = Number(year);
	const numericMonth = Number(month);
	const numericDay = Number(day);
	if (
		numericMonth < 1 ||
		numericMonth > 12 ||
		numericDay < 1 ||
		numericDay > daysInMonth(numericYear, numericMonth) ||
		Number(hour) > 23 ||
		Number(minute) > 59 ||
		Number(second) > 59
	)
		return undefined;
	const base = Date.parse(
		`${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
	);
	if (!Number.isFinite(base)) return undefined;
	const offset =
		zone === 'Z'
			? 0
			: (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4))) *
				(zone[0] === '+' ? 1 : -1);
	if (
		Math.abs(offset) > 23 * 60 + 59 ||
		(zone !== 'Z' && Number(zone.slice(4)) > 59)
	)
		return undefined;
	return {
		epoch: base - offset * 60_000,
		fraction: rawFraction.replace(/0+$/, ''),
	};
}

export function compareCanonicalTimestamps(
	left: string,
	right: string,
): number {
	const a = timestampParts(left);
	const b = timestampParts(right);
	if (!a || !b) return 0;
	if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
	const width = Math.max(a.fraction.length, b.fraction.length);
	const leftFraction = a.fraction.padEnd(width, '0');
	const rightFraction = b.fraction.padEnd(width, '0');
	return leftFraction < rightFraction
		? -1
		: leftFraction > rightFraction
			? 1
			: 0;
}

export function canonicalizeTimestamp(
	input: unknown,
): ValidationResult<CanonicalTimestamp> {
	const parsed = timestampParts(input);
	if (!parsed)
		return failure(
			'invalid-timestamp',
			"timestamp must match DevRadar's supported RFC 3339 profile",
		);
	const date = new Date(parsed.epoch);
	if (date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999)
		return failure(
			'invalid-timestamp',
			"timestamp must match DevRadar's supported RFC 3339 profile, including the four-digit UTC year range",
		);
	const iso = date.toISOString().replace(/\.\d{3}Z$/, '');
	const value = parsed.fraction ? `${iso}.${parsed.fraction}Z` : `${iso}Z`;
	return success(value as CanonicalTimestamp);
}

interface SharedInput {
	providerEventId: string | number;
	timestamp: string;
	repository: string;
}

export interface PushActivity {
	readonly family: 'push';
	readonly action: 'pushed';
	readonly providerEventId: CanonicalEventId;
	readonly timestamp: CanonicalTimestamp;
	readonly repository: CanonicalRepository;
	readonly ref: CanonicalRef;
	readonly pushSourceUrl?: string;
}

export interface PullRequestActivity {
	readonly family: 'pull-request';
	readonly action: PullRequestAction;
	readonly titleSource?: 'event' | 'detail';
	readonly providerEventId: CanonicalEventId;
	readonly timestamp: CanonicalTimestamp;
	readonly repository: CanonicalRepository;
	readonly number: CanonicalNumber;
	readonly title: string;
	readonly sourceUrl: string;
}

export interface IssueActivity {
	readonly family: 'issue';
	readonly action: IssueAction;
	readonly providerEventId: CanonicalEventId;
	readonly timestamp: CanonicalTimestamp;
	readonly repository: CanonicalRepository;
	readonly number: CanonicalNumber;
	readonly title: string;
	readonly sourceUrl: string;
}

export interface PullRequestReviewActivity {
	readonly family: 'pull-request-review';
	readonly action: 'created';
	readonly providerEventId: CanonicalEventId;
	readonly timestamp: CanonicalTimestamp;
	readonly repository: CanonicalRepository;
	readonly number: CanonicalNumber;
	readonly reviewId: CanonicalNumber;
	readonly sourceUrl: string;
}

export interface IssueCommentActivity {
	readonly family: 'comment';
	readonly action: 'issue-comment';
	readonly target: 'issue' | 'pull-request';
	readonly providerEventId: CanonicalEventId;
	readonly timestamp: CanonicalTimestamp;
	readonly repository: CanonicalRepository;
	readonly number: CanonicalNumber;
	readonly commentId: CanonicalNumber;
	readonly sourceUrl: string;
}

export interface PullRequestReviewCommentActivity {
	readonly family: 'comment';
	readonly action: 'review-comment';
	readonly providerEventId: CanonicalEventId;
	readonly timestamp: CanonicalTimestamp;
	readonly repository: CanonicalRepository;
	readonly number: CanonicalNumber;
	readonly commentId: CanonicalNumber;
	readonly sourceUrl: string;
}

export interface CommitCommentActivity {
	readonly family: 'comment';
	readonly action: 'commit-comment';
	readonly providerEventId: CanonicalEventId;
	readonly timestamp: CanonicalTimestamp;
	readonly repository: CanonicalRepository;
	readonly commitId: CanonicalCommitId;
	readonly commentId: CanonicalNumber;
	readonly sourceUrl: string;
}

export type CommentActivity =
	| IssueCommentActivity
	| PullRequestReviewCommentActivity
	| CommitCommentActivity;

export type Activity =
	| PushActivity
	| PullRequestActivity
	| PullRequestReviewActivity
	| IssueActivity
	| CommentActivity;

function common(
	input: SharedInput,
): ValidationResult<
	Pick<PushActivity, 'providerEventId' | 'timestamp' | 'repository'>
> {
	const providerEventId = canonicalizeEventId(input.providerEventId);
	if (!providerEventId.ok) return providerEventId;
	const timestamp = canonicalizeTimestamp(input.timestamp);
	if (!timestamp.ok) return timestamp;
	const repository = canonicalizeRepository(input.repository);
	if (!repository.ok) return repository;
	return success({
		providerEventId: providerEventId.value,
		timestamp: timestamp.value,
		repository: repository.value,
	});
}

export function createPushActivity(
	input: SharedInput & { ref: string; head?: string },
): ValidationResult<PushActivity> {
	const shared = common(input);
	if (!shared.ok) return shared;
	const ref = validateRef(input.ref);
	if (!ref.ok) return ref;
	let pushSourceUrl: string | undefined;
	if (input.head !== undefined) {
		const head = validateCommitId(input.head);
		if (head.ok)
			pushSourceUrl = `https://github.com/${shared.value.repository}/commit/${head.value}`;
	}
	if (!pushSourceUrl) {
		const prefix = input.ref.startsWith('refs/heads/')
			? 'refs/heads/'
			: input.ref.startsWith('refs/tags/')
				? 'refs/tags/'
				: undefined;
		if (prefix)
			pushSourceUrl = `https://github.com/${shared.value.repository}/tree/${input.ref
				.slice(prefix.length)
				.split('/')
				.map(encodePathComponent)
				.join('/')}`;
	}
	return success({
		...shared.value,
		family: 'push',
		action: 'pushed',
		ref: ref.value,
		...(pushSourceUrl ? { pushSourceUrl } : {}),
	});
}

export function encodePathComponent(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

export function repositoryUrl(repository: CanonicalRepository): string {
	return `https://github.com/${repository}`;
}

export function pullRequestUrl(
	repository: CanonicalRepository,
	number: CanonicalNumber,
): string {
	return `${repositoryUrl(repository)}/pull/${number}`;
}

export function issueUrl(
	repository: CanonicalRepository,
	number: CanonicalNumber,
): string {
	return `${repositoryUrl(repository)}/issues/${number}`;
}

function createObjectActivity<T extends PullRequestActivity | IssueActivity>(
	input: SharedInput & {
		number: string | number;
		title: string;
		action: T['action'];
	},
	family: T['family'],
): ValidationResult<T> {
	const shared = common(input);
	if (!shared.ok) return { ok: false, error: shared.error };
	if (
		typeof input.title !== 'string' ||
		input.title.length === 0 ||
		containsUnpairedSurrogate(input.title)
	)
		return failure('invalid-title', 'title must be a non-empty string');
	const number = canonicalizePositiveNumber(input.number);
	if (!number.ok) return { ok: false, error: number.error };
	const sourceUrl =
		family === 'pull-request'
			? pullRequestUrl(shared.value.repository, number.value)
			: issueUrl(shared.value.repository, number.value);
	return success({
		...shared.value,
		family,
		action: input.action,
		number: number.value,
		title: normalizeProviderText(input.title),
		sourceUrl,
	} as T);
}

export function createPullRequestActivity(
	input: SharedInput & {
		number: string | number;
		title: string;
		action: PullRequestAction;
	},
): ValidationResult<PullRequestActivity> {
	if (!['opened', 'reopened', 'closed', 'merged'].includes(input.action))
		return failure('invalid-action', 'unsupported pull-request action');
	return createObjectActivity(input, 'pull-request');
}

export function createIssueActivity(
	input: SharedInput & {
		number: string | number;
		title: string;
		action: IssueAction;
	},
): ValidationResult<IssueActivity> {
	if (!['opened', 'reopened', 'closed'].includes(input.action))
		return failure('invalid-action', 'unsupported issue action');
	return createObjectActivity(input, 'issue');
}

function optionalAnchoredSourceUrl(
	providerSourceUrl: unknown,
	expectedUrl: string,
	fallbackUrl: string,
): string {
	return providerSourceUrl === expectedUrl ? expectedUrl : fallbackUrl;
}

export function createPullRequestReviewActivity(
	input: SharedInput & {
		number: string | number;
		reviewId: string | number;
		providerSourceUrl?: unknown;
	},
): ValidationResult<PullRequestReviewActivity> {
	const shared = common(input);
	if (!shared.ok) return shared;
	const number = canonicalizePositiveNumber(input.number);
	if (!number.ok) return number;
	const reviewId = canonicalizePositiveNumber(input.reviewId);
	if (!reviewId.ok) return reviewId;
	const fallbackUrl = pullRequestUrl(shared.value.repository, number.value);
	const expectedUrl = `${fallbackUrl}#pullrequestreview-${reviewId.value}`;
	return success({
		...shared.value,
		family: 'pull-request-review',
		action: 'created',
		number: number.value,
		reviewId: reviewId.value,
		sourceUrl: optionalAnchoredSourceUrl(
			input.providerSourceUrl,
			expectedUrl,
			fallbackUrl,
		),
	});
}

export function createIssueCommentActivity(
	input: SharedInput & {
		number: string | number;
		target: 'issue' | 'pull-request';
		commentId: string | number;
		providerSourceUrl?: unknown;
	},
): ValidationResult<IssueCommentActivity> {
	const shared = common(input);
	if (!shared.ok) return shared;
	const number = canonicalizePositiveNumber(input.number);
	if (!number.ok) return number;
	const commentId = canonicalizePositiveNumber(input.commentId);
	if (!commentId.ok) return commentId;
	const fallbackUrl =
		input.target === 'pull-request'
			? pullRequestUrl(shared.value.repository, number.value)
			: issueUrl(shared.value.repository, number.value);
	const expectedUrl = `${fallbackUrl}#issuecomment-${commentId.value}`;
	return success({
		...shared.value,
		family: 'comment',
		action: 'issue-comment',
		target: input.target,
		number: number.value,
		commentId: commentId.value,
		sourceUrl: optionalAnchoredSourceUrl(
			input.providerSourceUrl,
			expectedUrl,
			fallbackUrl,
		),
	});
}

export function createPullRequestReviewCommentActivity(
	input: SharedInput & {
		number: string | number;
		commentId: string | number;
		providerSourceUrl?: unknown;
	},
): ValidationResult<PullRequestReviewCommentActivity> {
	const shared = common(input);
	if (!shared.ok) return shared;
	const number = canonicalizePositiveNumber(input.number);
	if (!number.ok) return number;
	const commentId = canonicalizePositiveNumber(input.commentId);
	if (!commentId.ok) return commentId;
	const fallbackUrl = pullRequestUrl(shared.value.repository, number.value);
	const expectedUrl = `${fallbackUrl}#discussion_r${commentId.value}`;
	return success({
		...shared.value,
		family: 'comment',
		action: 'review-comment',
		number: number.value,
		commentId: commentId.value,
		sourceUrl: optionalAnchoredSourceUrl(
			input.providerSourceUrl,
			expectedUrl,
			fallbackUrl,
		),
	});
}

export function createCommitCommentActivity(
	input: SharedInput & {
		commitId: unknown;
		commentId: string | number;
		providerSourceUrl?: unknown;
	},
): ValidationResult<CommitCommentActivity> {
	const shared = common(input);
	if (!shared.ok) return shared;
	const commitId = validateCommitId(input.commitId);
	if (!commitId.ok) return commitId;
	const commentId = canonicalizePositiveNumber(input.commentId);
	if (!commentId.ok) return commentId;
	const fallbackUrl = `${repositoryUrl(shared.value.repository)}/commit/${commitId.value}`;
	const expectedUrl = `${fallbackUrl}#commitcomment-${commentId.value}`;
	return success({
		...shared.value,
		family: 'comment',
		action: 'commit-comment',
		commitId: commitId.value,
		commentId: commentId.value,
		sourceUrl: optionalAnchoredSourceUrl(
			input.providerSourceUrl,
			expectedUrl,
			fallbackUrl,
		),
	});
}

export type TrackingStart =
	| { mode: 'available-recent' }
	| { mode: 'from-now' | 'from-date'; at: string };

export function isActivityEligible(
	activityTimestamp: string,
	start: TrackingStart,
): ValidationResult<boolean> {
	const activity = canonicalizeTimestamp(activityTimestamp);
	if (!activity.ok) return activity;
	if (start.mode === 'available-recent') return success(true);
	const trackingStart = canonicalizeTimestamp(start.at);
	if (!trackingStart.ok) return trackingStart;
	return success(
		compareCanonicalTimestamps(activity.value, trackingStart.value) >= 0,
	);
}

export function compareActivities(a: Activity, b: Activity): number {
	const timestampOrder = compareCanonicalTimestamps(a.timestamp, b.timestamp);
	if (timestampOrder !== 0) return timestampOrder > 0 ? -1 : 1;
	return a.providerEventId < b.providerEventId
		? -1
		: a.providerEventId > b.providerEventId
			? 1
			: 0;
}

export function areSameActivity(left: Activity, right: Activity): boolean {
	if (
		left.family !== right.family ||
		left.action !== right.action ||
		left.providerEventId !== right.providerEventId ||
		left.timestamp !== right.timestamp ||
		left.repository !== right.repository
	)
		return false;
	if (left.family === 'push' && right.family === 'push')
		return (
			left.ref === right.ref && left.pushSourceUrl === right.pushSourceUrl
		);
	if (left.family === 'pull-request' && right.family === 'pull-request')
		return (
			left.number === right.number &&
			left.title === right.title &&
			left.sourceUrl === right.sourceUrl
		);
	if (left.family === 'issue' && right.family === 'issue')
		return (
			left.number === right.number &&
			left.title === right.title &&
			left.sourceUrl === right.sourceUrl
		);
	if (
		left.family === 'pull-request-review' &&
		right.family === 'pull-request-review'
	)
		return (
			left.number === right.number &&
			left.reviewId === right.reviewId &&
			left.sourceUrl === right.sourceUrl
		);
	if (left.family === 'comment' && right.family === 'comment') {
		if (left.action === 'issue-comment' && right.action === 'issue-comment')
			return (
				left.target === right.target &&
				left.number === right.number &&
				left.commentId === right.commentId &&
				left.sourceUrl === right.sourceUrl
			);
		if (
			left.action === 'review-comment' &&
			right.action === 'review-comment'
		)
			return (
				left.number === right.number &&
				left.commentId === right.commentId &&
				left.sourceUrl === right.sourceUrl
			);
		if (
			left.action === 'commit-comment' &&
			right.action === 'commit-comment'
		)
			return (
				left.commitId === right.commitId &&
				left.commentId === right.commentId &&
				left.sourceUrl === right.sourceUrl
			);
	}
	return false;
}

export function preferCanonicalActivity(
	current: Activity,
	candidate: Activity,
): Activity {
	return current.family === 'pull-request' &&
		candidate.family === 'pull-request' &&
		current.titleSource === 'detail' &&
		candidate.titleSource !== 'detail'
		? candidate
		: current;
}

export function normalizeProviderText(input: string): string {
	const punctuation = new Set(
		Array.from('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'),
	);
	return Array.from(input, (character) => {
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
			return '�';
		return punctuation.has(character) ? `\\${character}` : character;
	}).join('');
}

export function serializeActivityFragment(activity: Activity): string {
	const repository = `[${activity.repository}](${repositoryUrl(activity.repository)})`;
	if (activity.family === 'push') {
		const ref = normalizeProviderText(activity.ref);
		return activity.pushSourceUrl
			? `Push to ${repository} at [${ref}](${activity.pushSourceUrl})`
			: `Push to ${repository} at ${ref}`;
	}
	if (activity.family === 'pull-request-review')
		return `Pull-request review on [#${activity.number}](${activity.sourceUrl}) in ${repository}`;
	if (activity.family === 'comment') {
		if (activity.action === 'issue-comment') {
			const label =
				activity.target === 'pull-request'
					? 'Pull-request comment'
					: 'Issue comment';
			return `${label} on [#${activity.number}](${activity.sourceUrl}) in ${repository}`;
		}
		if (activity.action === 'review-comment')
			return `Pull-request review comment on [#${activity.number}](${activity.sourceUrl}) in ${repository}`;
		return `Commit comment on [${activity.commitId}](${activity.sourceUrl}) in ${repository}`;
	}
	const title = activity.title;
	const label = activity.family === 'pull-request' ? 'Pull request' : 'Issue';
	return `${label} [#${activity.number}](${activity.sourceUrl}) ${activity.action} in ${repository}: ${title}`;
}
