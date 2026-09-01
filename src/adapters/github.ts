import {
	canonicalizeRepository,
	canonicalizePositiveNumber,
	canonicalizeTimestamp,
	createIssueActivity,
	createPullRequestActivity,
	createPushActivity,
	type Activity,
	type PullRequestAction,
	validateRef,
} from '../domain/activity';
import {
	isCanonicalGitHubUsername,
	isCanonicalPositiveDecimalString,
} from '../domain/primitives';
import type { GitHubRequestPolicyV1 } from '../domain/settings';
import type {
	GitHubIdentityRequest,
	GitHubIdentityResult,
	GitHubPolicyObservation,
} from '../application/github-identity';
export type {
	GitHubIdentity,
	GitHubIdentityRequest,
	GitHubIdentityResult,
	GitHubPolicyObservation,
} from '../application/github-identity';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const EVENTS_PAGE_SIZE = 100;
const MAX_EVENTS_PAGES = 3;
const PRIMARY_FALLBACK_MS = 60 * 60 * 1000;
const SECONDARY_FALLBACK_MS = 60 * 1000;

const REQUEST_HEADERS = (
	pluginVersion: string,
): Readonly<Record<string, string>> => ({
	Accept: 'application/vnd.github+json',
	'User-Agent': `DevRadar/${pluginVersion} (https://github.com/FerdiHS/devradar)`,
	'X-GitHub-Api-Version': API_VERSION,
});

export type GitHubTransportRequest = {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
};

export type GitHubTransportResponse = {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly json: unknown;
};

export type GitHubTransport = (
	request: GitHubTransportRequest,
) => Promise<GitHubTransportResponse>;

export class GitHubTransportContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GitHubTransportContractError';
	}
}

export type GitHubFailureCategory =
	| 'invalid-input'
	| 'invalid-policy'
	| 'transport'
	| 'unexpected-status'
	| 'not-found'
	| 'malformed-provider-data'
	| 'identity-mismatch'
	| 'pagination'
	| 'rate-limit'
	| 'api-version'
	| 'unexpected-not-modified'
	| 'redirect-contract'
	| 'transport-contract';

export type GitHubFailure = {
	readonly category: GitHubFailureCategory;
	readonly message: string;
};

type ResultBase = {
	readonly requestAttempted: boolean;
	readonly policy: GitHubPolicyObservation;
};

export type GitHubResult<T> =
	| (ResultBase & {
			readonly kind: 'success';
			readonly requestAttempted: true;
			readonly data: T;
	  })
	| (ResultBase & {
			readonly kind: 'no-request';
			readonly requestAttempted: false;
			readonly notBefore?: string;
	  })
	| (ResultBase & {
			readonly kind: 'person-failure';
			readonly failure: GitHubFailure;
	  })
	| (ResultBase & {
			readonly kind: 'provider-failure';
			readonly failure: GitHubFailure;
	  });

export type GitHubEventsRequest = {
	readonly username: string;
	readonly githubAccountId: string;
	readonly globalPolicy?: GitHubRequestPolicyV1;
	readonly pollNotBefore?: string;
};

export type GitHubAdapterOptions = {
	readonly pluginVersion: string;
	readonly transport: GitHubTransport;
	readonly now?: () => number;
};

type BoundaryState = {
	rateLimitNotBeforeMs?: number;
	pollNotBeforeMs?: number;
};

type ResponseObservation = {
	readonly boundary: BoundaryState;
	readonly quotaExhausted: boolean;
	readonly failure?: {
		readonly scope: 'person' | 'provider';
		readonly failure: GitHubFailure;
	};
};

type EventEnvelope = {
	readonly providerEventId: string;
	readonly timestamp: string;
	readonly repository: string;
};

type CommonEventResult =
	| { readonly kind: 'valid'; readonly envelope: EventEnvelope }
	| { readonly kind: 'invalid' }
	| { readonly kind: 'identity-mismatch' };

type NextPage = {
	readonly url: string;
	readonly page: number;
};

type LinkParseResult =
	{ readonly ok: true; readonly next?: NextPage } | { readonly ok: false };

type MappingResult =
	| { readonly kind: 'activity'; readonly activity: Activity }
	| { readonly kind: 'ignored' }
	| { readonly kind: 'identity-mismatch' }
	| {
			readonly kind: 'pull-request-needs-details';
			readonly envelope: EventEnvelope;
			readonly number: string;
			readonly eventAction: PullRequestAction;
			readonly normalizedAction?: PullRequestAction;
			readonly requiresMerged: boolean;
			readonly url: string;
	  }
	| { readonly kind: 'invalid' };

type PullRequestDetailsResult =
	| {
			readonly kind: 'success';
			readonly title: string;
			readonly merged?: boolean;
			readonly state: BoundaryState;
			readonly retryUsed: boolean;
			readonly quotaExhausted: boolean;
	  }
	| {
			readonly kind: 'failure';
			readonly state: BoundaryState;
			readonly retryUsed: boolean;
			readonly quotaExhausted: boolean;
			readonly scope: 'person' | 'provider';
			readonly failure: GitHubFailure;
	  };

const failure = (
	category: GitHubFailureCategory,
	message: string,
): GitHubFailure => ({ category, message });

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		return undefined;
	return value as Record<string, unknown>;
}

function readOwn(record: Record<string, unknown>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function headerValue(
	headers: Readonly<Record<string, string>>,
	name: string,
): string | undefined {
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected) return value;
	}
	return undefined;
}

function isNonNegativeInteger(value: string | undefined): boolean {
	return value !== undefined && /^(?:0|[1-9]\d*)$/.test(value);
}

function parseSafeNonNegativeInteger(
	value: string | undefined,
): number | undefined {
	if (!isNonNegativeInteger(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseDelaySeconds(value: string | undefined): number | undefined {
	return parseSafeNonNegativeInteger(value);
}

function parseEpochSeconds(value: string | undefined): number | undefined {
	const parsed = parseSafeNonNegativeInteger(value);
	if (parsed === undefined) return undefined;
	return validMilliseconds(parsed * 1000);
}

function validMilliseconds(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	const date = new Date(value);
	const year = date.getUTCFullYear();
	return Number.isNaN(date.getTime()) || year < 0 || year > 9999
		? undefined
		: value;
}

function maxBoundary(
	current: number | undefined,
	candidate: number | undefined,
) {
	if (current === undefined) return candidate;
	if (candidate === undefined) return current;
	return Math.max(current, candidate);
}

function toPluginTimestamp(
	milliseconds: number | undefined,
): string | undefined {
	const valid = validMilliseconds(milliseconds);
	return valid === undefined ? undefined : new Date(valid).toISOString();
}

function toPolicy(state: BoundaryState): GitHubPolicyObservation {
	const rateLimitNotBefore = toPluginTimestamp(state.rateLimitNotBeforeMs);
	const pollNotBefore = toPluginTimestamp(state.pollNotBeforeMs);
	return {
		...(rateLimitNotBefore === undefined ? {} : { rateLimitNotBefore }),
		...(pollNotBefore === undefined ? {} : { pollNotBefore }),
	};
}

function resultSuccess<T>(data: T, state: BoundaryState): GitHubResult<T> {
	return {
		kind: 'success',
		requestAttempted: true,
		data,
		policy: toPolicy(state),
	};
}

function resultNoRequest<T>(
	notBefore: string,
	state: BoundaryState,
): GitHubResult<T> {
	return {
		kind: 'no-request',
		requestAttempted: false,
		notBefore,
		policy: toPolicy(state),
	};
}

function resultPersonFailure<T>(
	failureValue: GitHubFailure,
	state: BoundaryState,
	requestAttempted = true,
): GitHubResult<T> {
	return {
		kind: 'person-failure',
		requestAttempted,
		failure: failureValue,
		policy: toPolicy(state),
	};
}

function resultProviderFailure<T>(
	failureValue: GitHubFailure,
	state: BoundaryState,
	requestAttempted = true,
): GitHubResult<T> {
	return {
		kind: 'provider-failure',
		requestAttempted,
		failure: failureValue,
		policy: toPolicy(state),
	};
}

function boundaryMilliseconds(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function policyBoundary(values: readonly (string | undefined)[]): {
	readonly invalid: boolean;
	readonly boundary?: string;
} {
	let latest: number | undefined;
	for (const value of values) {
		if (value === undefined) continue;
		const milliseconds = boundaryMilliseconds(value);
		if (
			milliseconds === undefined ||
			toPluginTimestamp(milliseconds) !== value
		)
			return { invalid: true };
		latest = maxBoundary(latest, milliseconds);
	}
	const boundary = toPluginTimestamp(latest);
	if (latest !== undefined && boundary === undefined)
		return { invalid: true };
	return {
		invalid: false,
		...(boundary === undefined ? {} : { boundary }),
	};
}

function secondaryLimitMessage(json: unknown): boolean {
	const record = asRecord(json);
	const message =
		record === undefined ? undefined : readOwn(record, 'message');
	return (
		typeof message === 'string' &&
		/^\s*you\s+have\s+exceeded\s+a\s+secondary\s+rate\s+limit\b/i.test(
			message,
		)
	);
}

function pinnedApiVersionFailure(status: number, json: unknown): boolean {
	const record = asRecord(json);
	const message =
		record === undefined ? undefined : readOwn(record, 'message');
	if (typeof message !== 'string') return false;
	const unsupportedVersion =
		/^\s*(?:the\s+)?(?:requested\s+)?api\s+version(?:\s+requested)?\s+(?:(?:is|has\s+been)\s+)?(?:retired|unsupported|not\s+supported|no\s+longer\s+supported)\b/i.test(
			message,
		);
	if (!unsupportedVersion) return false;
	if (status === 410) return true;
	if (status !== 400) return false;
	return true;
}

function observeResponse(
	response: GitHubTransportResponse,
	nowMilliseconds: number,
	state: BoundaryState,
): ResponseObservation {
	const remainingHeader = headerValue(
		response.headers,
		'x-ratelimit-remaining',
	);
	const remaining = parseSafeNonNegativeInteger(remainingHeader);
	const resetMilliseconds = parseEpochSeconds(
		headerValue(response.headers, 'x-ratelimit-reset'),
	);
	const retryAfterSeconds = parseDelaySeconds(
		headerValue(response.headers, 'retry-after'),
	);
	const retryAfterMilliseconds =
		retryAfterSeconds === undefined
			? undefined
			: validMilliseconds(nowMilliseconds + retryAfterSeconds * 1000);
	const validFutureReset =
		resetMilliseconds !== undefined && resetMilliseconds > nowMilliseconds
			? resetMilliseconds
			: undefined;
	const validFutureRetry =
		retryAfterMilliseconds !== undefined &&
		retryAfterMilliseconds > nowMilliseconds
			? retryAfterMilliseconds
			: undefined;
	const latestTimingBoundary = maxBoundary(
		validFutureReset,
		validFutureRetry,
	);
	const quotaExhausted = remaining === 0;
	let rateLimitNotBeforeMs = state.rateLimitNotBeforeMs;

	if (quotaExhausted) {
		const conservativeFallback =
			validFutureReset === undefined &&
			(response.status === 403 ||
				response.status === 429 ||
				latestTimingBoundary === undefined)
				? nowMilliseconds + PRIMARY_FALLBACK_MS
				: undefined;
		rateLimitNotBeforeMs = maxBoundary(
			rateLimitNotBeforeMs,
			maxBoundary(latestTimingBoundary, conservativeFallback),
		);
	}

	if (response.status !== 403 && response.status !== 429)
		return {
			boundary: { ...state, rateLimitNotBeforeMs },
			quotaExhausted,
		};

	if (quotaExhausted) {
		return {
			boundary: { ...state, rateLimitNotBeforeMs },
			quotaExhausted,
			failure: {
				scope: 'provider',
				failure: failure('rate-limit', 'primary rate limit observed'),
			},
		};
	}

	if (
		secondaryLimitMessage(response.json) ||
		retryAfterMilliseconds !== undefined
	) {
		const secondaryFallback =
			retryAfterMilliseconds === undefined
				? nowMilliseconds + SECONDARY_FALLBACK_MS
				: undefined;
		const secondaryTimingBoundary = retryAfterMilliseconds;
		rateLimitNotBeforeMs = maxBoundary(
			rateLimitNotBeforeMs,
			maxBoundary(secondaryTimingBoundary, secondaryFallback),
		);
		return {
			boundary: { ...state, rateLimitNotBeforeMs },
			quotaExhausted,
			failure: {
				scope: 'provider',
				failure: failure('rate-limit', 'secondary rate limit observed'),
			},
		};
	}

	rateLimitNotBeforeMs = maxBoundary(
		rateLimitNotBeforeMs,
		maxBoundary(
			latestTimingBoundary,
			nowMilliseconds + PRIMARY_FALLBACK_MS,
		),
	);
	return {
		boundary: { ...state, rateLimitNotBeforeMs },
		quotaExhausted,
		failure: {
			scope: 'provider',
			failure: failure(
				'rate-limit',
				'conservative provider rate-limit boundary',
			),
		},
	};
}

function parsePollInterval(
	response: GitHubTransportResponse,
	nowMilliseconds: number,
): number | undefined {
	const value = headerValue(response.headers, 'x-poll-interval');
	const seconds = parseSafeNonNegativeInteger(value);
	if (seconds === undefined) return undefined;
	return validMilliseconds(nowMilliseconds + seconds * 1000);
}

function classifyUnexpectedResponse(
	response: GitHubTransportResponse,
	nowMilliseconds: number,
	state: BoundaryState,
): {
	readonly state: BoundaryState;
	readonly failure: {
		readonly scope: 'person' | 'provider';
		readonly value: GitHubFailure;
	};
} {
	const observation = observeResponse(response, nowMilliseconds, state);
	if (observation.failure !== undefined)
		return {
			state: observation.boundary,
			failure: {
				scope: observation.failure.scope,
				value: observation.failure.failure,
			},
		};
	if (pinnedApiVersionFailure(response.status, response.json))
		return {
			state: observation.boundary,
			failure: {
				scope: 'provider',
				value: failure(
					'api-version',
					'pinned GitHub API version is incompatible',
				),
			},
		};
	if (response.status === 304)
		return {
			state: observation.boundary,
			failure: {
				scope: 'person',
				value: failure(
					'unexpected-not-modified',
					'unexpected 304 response',
				),
			},
		};
	if (response.status === 404)
		return {
			state: observation.boundary,
			failure: {
				scope: 'person',
				value: failure('not-found', 'GitHub resource was not found'),
			},
		};
	if (response.status >= 300 && response.status < 400)
		return {
			state: observation.boundary,
			failure: {
				scope: 'provider',
				value: failure(
					'redirect-contract',
					'redirect behavior cannot preserve the provider contract',
				),
			},
		};
	return {
		state: observation.boundary,
		failure: {
			scope: 'person',
			value: failure(
				'unexpected-status',
				'unexpected GitHub response status',
			),
		},
	};
}

function parseGitHubEventId(value: unknown): string | undefined {
	if (typeof value === 'number')
		return Number.isSafeInteger(value) && value > 0
			? String(value)
			: undefined;
	if (typeof value === 'string' && isCanonicalPositiveDecimalString(value))
		return value;
	return undefined;
}

function parseGitHubAccountId(value: unknown): string | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
		? String(value)
		: undefined;
}

function isUsableProviderToken(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		!/\s/.test(value) &&
		![...value].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	);
}

function isRelationType(value: string): boolean {
	return (
		/^[A-Za-z][A-Za-z0-9.-]*$/.test(value) ||
		/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(value)
	);
}

function validateCommonEvent(
	event: Record<string, unknown>,
	username: string,
	githubAccountId: string,
): CommonEventResult {
	const providerEventId = parseGitHubEventId(readOwn(event, 'id'));
	const timestamp = readOwn(event, 'created_at');
	const repositoryRecord = asRecord(readOwn(event, 'repo'));
	const repository =
		repositoryRecord === undefined
			? undefined
			: readOwn(repositoryRecord, 'name');
	const actor = asRecord(readOwn(event, 'actor'));
	const actorId =
		actor === undefined
			? undefined
			: parseGitHubAccountId(readOwn(actor, 'id'));
	const actorLogin =
		actor === undefined ? undefined : readOwn(actor, 'login');
	const canonicalTimestamp =
		typeof timestamp === 'string'
			? canonicalizeTimestamp(timestamp)
			: undefined;
	const canonicalRepository = canonicalizeRepository(repository);
	if (
		providerEventId === undefined ||
		canonicalTimestamp === undefined ||
		!canonicalTimestamp.ok ||
		!canonicalRepository.ok ||
		actorId === undefined ||
		typeof actorLogin !== 'string' ||
		!isCanonicalGitHubUsername(actorLogin)
	)
		return { kind: 'invalid' };
	if (
		actorId !== githubAccountId ||
		actorLogin.toLowerCase() !== username.toLowerCase()
	)
		return { kind: 'identity-mismatch' };
	return {
		kind: 'valid',
		envelope: {
			providerEventId,
			timestamp: canonicalTimestamp.value,
			repository: canonicalRepository.value,
		},
	};
}

function mapSupportedEvent(
	event: Record<string, unknown>,
	type: string,
	username: string,
	githubAccountId: string,
): MappingResult {
	const common = validateCommonEvent(event, username, githubAccountId);
	if (common.kind === 'invalid') return { kind: 'invalid' };
	if (common.kind === 'identity-mismatch')
		return { kind: 'identity-mismatch' };
	const envelope = common.envelope;
	const payload = asRecord(readOwn(event, 'payload'));
	if (payload === undefined) return { kind: 'invalid' };

	if (type === 'PushEvent') {
		const ref = readOwn(payload, 'ref');
		if (typeof ref !== 'string' || !validateRef(ref).ok)
			return { kind: 'invalid' };
		const head = readOwn(payload, 'head');
		const activity = createPushActivity({
			...envelope,
			ref,
			...(typeof head === 'string' ? { head } : {}),
		});
		return activity.ok
			? { kind: 'activity', activity: activity.value }
			: { kind: 'invalid' };
	}

	const action = readOwn(payload, 'action');
	if (!isUsableProviderToken(action)) return { kind: 'invalid' };

	if (type === 'PullRequestEvent') {
		if (!['opened', 'reopened', 'closed', 'merged'].includes(action))
			return { kind: 'ignored' };
		const eventAction = action as PullRequestAction;
		const pullRequest = asRecord(readOwn(payload, 'pull_request'));
		if (pullRequest === undefined) return { kind: 'invalid' };
		const number = readOwn(payload, 'number');
		const title = readOwn(pullRequest, 'title');
		if (typeof number !== 'string' && typeof number !== 'number')
			return { kind: 'invalid' };
		if (title !== undefined && typeof title !== 'string')
			return { kind: 'invalid' };
		let normalizedAction: PullRequestAction | undefined;
		if (action === 'opened' || action === 'reopened')
			normalizedAction = eventAction;
		else {
			const merged = readOwn(pullRequest, 'merged');
			if (merged !== undefined && typeof merged !== 'boolean')
				return { kind: 'invalid' };
			if (typeof merged === 'boolean') {
				normalizedAction = merged ? 'merged' : 'closed';
				if (eventAction === 'merged' && !merged)
					return { kind: 'invalid' };
			}
		}
		const canonicalNumber = canonicalizePositiveNumber(number);
		if (!canonicalNumber.ok) return { kind: 'invalid' };
		if (title === undefined || normalizedAction === undefined)
			return {
				kind: 'pull-request-needs-details',
				envelope,
				number: canonicalNumber.value,
				eventAction,
				...(normalizedAction === undefined ? {} : { normalizedAction }),
				requiresMerged:
					eventAction === 'closed' || eventAction === 'merged',
				url: `${API_ORIGIN}/repos/${envelope.repository}/pulls/${canonicalNumber.value}`,
			};
		const activity = createPullRequestActivity({
			...envelope,
			number,
			title,
			action: normalizedAction,
		});
		return activity.ok
			? { kind: 'activity', activity: activity.value }
			: { kind: 'invalid' };
	}

	if (type === 'IssuesEvent') {
		if (!['opened', 'reopened', 'closed'].includes(action))
			return { kind: 'ignored' };
		const issue = asRecord(readOwn(payload, 'issue'));
		if (issue === undefined) return { kind: 'invalid' };
		const number = readOwn(issue, 'number');
		const title = readOwn(issue, 'title');
		if (
			(typeof number !== 'string' && typeof number !== 'number') ||
			typeof title !== 'string'
		)
			return { kind: 'invalid' };
		const activity = createIssueActivity({
			...envelope,
			number,
			title,
			action: action as 'opened' | 'reopened' | 'closed',
		});
		return activity.ok
			? { kind: 'activity', activity: activity.value }
			: { kind: 'invalid' };
	}

	return { kind: 'ignored' };
}

function mapEvent(
	event: unknown,
	username: string,
	githubAccountId: string,
): MappingResult {
	const record = asRecord(event);
	if (record === undefined) return { kind: 'invalid' };
	const type = readOwn(record, 'type');
	if (!isUsableProviderToken(type)) return { kind: 'invalid' };
	if (!['PushEvent', 'PullRequestEvent', 'IssuesEvent'].includes(type))
		return { kind: 'ignored' };
	return mapSupportedEvent(record, type, username, githubAccountId);
}

function splitLinkHeader(value: string): string[] | undefined {
	const parts: string[] = [];
	let start = 0;
	let angleDepth = 0;
	let quoted = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === '"') quoted = !quoted;
		else if (!quoted && character === '<') angleDepth += 1;
		else if (!quoted && character === '>' && angleDepth > 0)
			angleDepth -= 1;
		else if (!quoted && angleDepth === 0 && character === ',') {
			parts.push(value.slice(start, index));
			start = index + 1;
		}
	}
	if (quoted || angleDepth !== 0) return undefined;
	parts.push(value.slice(start));
	return parts;
}

function validateNextUrl(
	value: string,
	username: string,
	githubAccountId: string,
	currentPage: number,
): NextPage | undefined {
	const queryIndex = value.indexOf('?');
	const expectedUsernameBase = `${API_ORIGIN}/users/${username}/events/public`;
	const expectedAccountBase = `${API_ORIGIN}/user/${githubAccountId}/events/public`;
	if (
		queryIndex < 0 ||
		(value.slice(0, queryIndex) !== expectedUsernameBase &&
			value.slice(0, queryIndex) !== expectedAccountBase)
	)
		return undefined;
	const rawPath = value.slice(0, queryIndex);
	if (
		/\s/.test(value) ||
		value.includes('\\') ||
		value.includes('#') ||
		/(?:^|\/)\.\.?(?:\/|$)/.test(rawPath)
	)
		return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (
		url.protocol !== 'https:' ||
		url.host !== 'api.github.com' ||
		url.username !== '' ||
		url.password !== '' ||
		url.hash !== '' ||
		(url.pathname !== `/users/${username}/events/public` &&
			url.pathname !== `/user/${githubAccountId}/events/public`)
	)
		return undefined;
	const parameters = [...url.searchParams.entries()];
	if (parameters.length !== 2) return undefined;
	const pages = parameters.filter(([key]) => key === 'page');
	const sizes = parameters.filter(([key]) => key === 'per_page');
	if (
		pages.length !== 1 ||
		sizes.length !== 1 ||
		sizes[0]?.[1] !== String(EVENTS_PAGE_SIZE) ||
		pages[0]?.[1] !== String(currentPage + 1)
	)
		return undefined;
	if (url.pathname === `/user/${githubAccountId}/events/public`)
		url.pathname = `/users/${username}/events/public`;
	return { url: url.toString(), page: currentPage + 1 };
}

function parseNextPage(
	response: GitHubTransportResponse,
	username: string,
	githubAccountId: string,
	currentPage: number,
): LinkParseResult {
	const value = headerValue(response.headers, 'link');
	if (value === undefined) return { ok: true };
	const parts = splitLinkHeader(value);
	if (parts === undefined || parts.some((part) => part.trim() === ''))
		return { ok: false };
	let next: NextPage | undefined;
	for (const part of parts) {
		const match = /^\s*<([^>]*)>(.*)$/.exec(part);
		if (match === null) return { ok: false };
		const target = match[1];
		const rawParameters = match[2];
		if (
			rawParameters === undefined ||
			(rawParameters.trim() !== '' && !/^\s*;/.test(rawParameters))
		)
			return { ok: false };
		if (target === undefined || target.length === 0) return { ok: false };
		const parameters = rawParameters
			.split(';')
			.map((parameter) => parameter.trim());
		if (parameters[0] === '') parameters.shift();
		if (parameters.some((parameter) => parameter.length === 0))
			return { ok: false };
		let relation: string | undefined;
		for (const parameter of parameters) {
			const parameterMatch =
				/^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+\-.^_`|~0-9A-Za-z]+))$/.exec(
					parameter,
				);
			if (parameterMatch === null) return { ok: false };
			const name = parameterMatch[1];
			const value = parameterMatch[2] ?? parameterMatch[3];
			if (name?.toLowerCase() === 'anchor') return { ok: false };
			if (name?.toLowerCase() === 'rel') {
				if (relation !== undefined) return { ok: false };
				if (value === undefined) return { ok: false };
				const unquoted =
					parameterMatch[2] === undefined
						? value
						: value.replace(/\\([\s\S])/g, '$1');
				const relationTypes = unquoted.split(' ');
				if (
					relationTypes.some(
						(relationType) => !isRelationType(relationType),
					)
				)
					return { ok: false };
				relation = unquoted;
			}
		}
		if (relation === undefined) return { ok: false };
		if (
			relation.split(' ').some((token) => token.toLowerCase() === 'next')
		) {
			if (next !== undefined) return { ok: false };
			next = validateNextUrl(
				target,
				username,
				githubAccountId,
				currentPage,
			);
			if (next === undefined) return { ok: false };
		}
	}
	return { ok: true, ...(next === undefined ? {} : { next }) };
}

function hasSameActivity(left: Activity, right: Activity): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export class GitHubAdapter {
	private readonly pluginVersion: string;
	private readonly transport: GitHubTransport;
	private readonly now: () => number;

	constructor(options: GitHubAdapterOptions) {
		this.pluginVersion = options.pluginVersion;
		this.transport = options.transport;
		this.now = options.now ?? Date.now;
	}

	private async retrievePullRequestDetails(
		url: string,
		eventAction: PullRequestAction,
		requiresMerged: boolean,
		initialState: BoundaryState,
		initialRetryUsed: boolean,
	): Promise<PullRequestDetailsResult> {
		let state = initialState;
		let retryUsed = initialRetryUsed;
		let response: GitHubTransportResponse | undefined;
		let responseObservation: ResponseObservation | undefined;
		let responseTime: number | undefined;

		while (response === undefined) {
			try {
				response = await this.transport({
					url,
					headers: REQUEST_HEADERS(this.pluginVersion),
				});
			} catch (error) {
				if (error instanceof GitHubTransportContractError)
					return {
						kind: 'failure',
						state,
						retryUsed,
						quotaExhausted: false,
						scope: 'provider',
						failure: failure('transport-contract', error.message),
					};
				if (retryUsed)
					return {
						kind: 'failure',
						state,
						retryUsed,
						quotaExhausted: false,
						scope: 'person',
						failure: failure(
							'transport',
							'GitHub transport failed after retry budget',
						),
					};
				retryUsed = true;
				continue;
			}
			if (
				response.status >= 500 &&
				response.status <= 599 &&
				!retryUsed
			) {
				const retryResponseTime = this.now();
				const retryObservation = observeResponse(
					response,
					retryResponseTime,
					state,
				);
				state = retryObservation.boundary;
				if (retryObservation.quotaExhausted) {
					responseObservation = retryObservation;
					responseTime = retryResponseTime;
					break;
				}
				response = undefined;
				retryUsed = true;
			}
		}

		responseTime ??= this.now();
		const observation =
			responseObservation ??
			observeResponse(response, responseTime, state);
		state = observation.boundary;
		if (observation.failure !== undefined)
			return {
				kind: 'failure',
				state,
				retryUsed,
				quotaExhausted: observation.quotaExhausted,
				scope: observation.failure.scope,
				failure: observation.failure.failure,
			};
		if (response.status !== 200) {
			const classified = classifyUnexpectedResponse(
				response,
				responseTime,
				state,
			);
			return {
				kind: 'failure',
				state: classified.state,
				retryUsed,
				quotaExhausted: observation.quotaExhausted,
				scope: classified.failure.scope,
				failure: classified.failure.value,
			};
		}

		const body = asRecord(response.json);
		const title = body === undefined ? undefined : readOwn(body, 'title');
		const merged = body === undefined ? undefined : readOwn(body, 'merged');
		if (
			typeof title !== 'string' ||
			(requiresMerged &&
				(typeof merged !== 'boolean' ||
					(eventAction === 'merged' && merged !== true)))
		)
			return {
				kind: 'failure',
				state,
				retryUsed,
				quotaExhausted: observation.quotaExhausted,
				scope: 'person',
				failure: failure(
					'malformed-provider-data',
					'malformed GitHub pull request response',
				),
			};
		return {
			kind: 'success',
			title,
			...(typeof merged === 'boolean' ? { merged } : {}),
			state,
			retryUsed,
			quotaExhausted: observation.quotaExhausted,
		};
	}

	async resolveIdentity(
		input: GitHubIdentityRequest,
	): Promise<GitHubIdentityResult> {
		const state: BoundaryState = {};
		const policy = policyBoundary([input.globalPolicy?.rateLimitNotBefore]);
		if (policy.invalid)
			return resultProviderFailure(
				failure(
					'invalid-policy',
					'invalid global provider-policy boundary',
				),
				state,
				false,
			);
		const nowMilliseconds = this.now();
		const notBeforeMilliseconds = boundaryMilliseconds(policy.boundary);
		if (
			notBeforeMilliseconds !== undefined &&
			nowMilliseconds < notBeforeMilliseconds
		)
			return resultNoRequest(policy.boundary ?? '', state);
		if (!isCanonicalGitHubUsername(input.username))
			return resultPersonFailure(
				failure('invalid-input', 'invalid GitHub username'),
				state,
				false,
			);

		const url = `${API_ORIGIN}/users/${input.username}`;
		let retryUsed = false;
		let response: GitHubTransportResponse | undefined;
		let responseObservation: ResponseObservation | undefined;
		let responseTime: number | undefined;
		while (response === undefined) {
			try {
				response = await this.transport({
					url,
					headers: REQUEST_HEADERS(this.pluginVersion),
				});
			} catch (error) {
				if (error instanceof GitHubTransportContractError)
					return resultProviderFailure(
						failure('transport-contract', error.message),
						state,
						false,
					);
				if (retryUsed)
					return resultPersonFailure(
						failure(
							'transport',
							'GitHub transport failed after retry budget',
						),
						state,
					);
				retryUsed = true;
				continue;
			}
			if (
				response.status >= 500 &&
				response.status <= 599 &&
				!retryUsed
			) {
				const retryResponseTime = this.now();
				const retryObservation = observeResponse(
					response,
					retryResponseTime,
					state,
				);
				state.rateLimitNotBeforeMs =
					retryObservation.boundary.rateLimitNotBeforeMs;
				if (retryObservation.quotaExhausted) {
					responseObservation = retryObservation;
					responseTime = retryResponseTime;
					break;
				}
				response = undefined;
				retryUsed = true;
			}
		}

		responseTime ??= this.now();
		const observation =
			responseObservation ??
			observeResponse(response, responseTime, state);
		const observedState = observation.boundary;
		if (response.status !== 200) {
			const classified = classifyUnexpectedResponse(
				response,
				responseTime,
				observedState,
			);
			return classified.failure.scope === 'provider'
				? resultProviderFailure(
						classified.failure.value,
						classified.state,
					)
				: resultPersonFailure(
						classified.failure.value,
						classified.state,
					);
		}
		const body = asRecord(response.json);
		if (body === undefined)
			return resultPersonFailure(
				failure(
					'malformed-provider-data',
					'malformed GitHub identity response',
				),
				observedState,
			);
		const login = readOwn(body, 'login');
		const id = parseGitHubAccountId(readOwn(body, 'id'));
		const type = readOwn(body, 'type');
		if (
			typeof login !== 'string' ||
			!isCanonicalGitHubUsername(login) ||
			id === undefined ||
			type !== 'User'
		)
			return resultPersonFailure(
				failure(
					'malformed-provider-data',
					'malformed GitHub identity data',
				),
				observedState,
			);
		return resultSuccess(
			{ username: login, githubAccountId: id },
			observedState,
		);
	}

	async retrieveEvents(
		input: GitHubEventsRequest,
	): Promise<GitHubResult<{ readonly activities: readonly Activity[] }>> {
		const state: BoundaryState = {};
		const globalPolicy = policyBoundary([
			input.globalPolicy?.rateLimitNotBefore,
		]);
		if (globalPolicy.invalid)
			return resultProviderFailure(
				failure(
					'invalid-policy',
					'invalid global provider-policy boundary',
				),
				state,
				false,
			);
		const personPolicy = policyBoundary([input.pollNotBefore]);
		if (personPolicy.invalid)
			return resultPersonFailure(
				failure('invalid-policy', 'invalid provider-policy boundary'),
				state,
				false,
			);
		const policy = policyBoundary([
			globalPolicy.boundary,
			personPolicy.boundary,
		]);
		const nowMilliseconds = this.now();
		const notBeforeMilliseconds = boundaryMilliseconds(policy.boundary);
		if (
			notBeforeMilliseconds !== undefined &&
			nowMilliseconds < notBeforeMilliseconds
		)
			return resultNoRequest(policy.boundary ?? '', state);
		if (
			!isCanonicalGitHubUsername(input.username) ||
			!isCanonicalPositiveDecimalString(input.githubAccountId)
		)
			return resultPersonFailure(
				failure('invalid-input', 'invalid followed-person identity'),
				state,
				false,
			);

		let page = 1;
		let url = `${API_ORIGIN}/users/${input.username}/events/public?per_page=${EVENTS_PAGE_SIZE}`;
		let retryUsed = false;
		let pollNotBeforeMs: number | undefined;
		const activities = new Map<string, Activity>();

		while (true) {
			let response: GitHubTransportResponse | undefined;
			let responseObservation: ResponseObservation | undefined;
			let responseTime: number | undefined;
			while (response === undefined) {
				try {
					response = await this.transport({
						url,
						headers: REQUEST_HEADERS(this.pluginVersion),
					});
				} catch (error) {
					if (error instanceof GitHubTransportContractError)
						return resultProviderFailure(
							failure('transport-contract', error.message),
							{ ...state, pollNotBeforeMs },
							false,
						);
					if (retryUsed)
						return resultPersonFailure(
							failure(
								'transport',
								'GitHub transport failed after retry budget',
							),
							{ ...state, pollNotBeforeMs },
						);
					retryUsed = true;
					continue;
				}
				if (
					response.status >= 500 &&
					response.status <= 599 &&
					!retryUsed
				) {
					const retryResponseTime = this.now();
					const retryObservation = observeResponse(
						response,
						retryResponseTime,
						{ ...state, pollNotBeforeMs },
					);
					state.rateLimitNotBeforeMs =
						retryObservation.boundary.rateLimitNotBeforeMs;
					if (retryObservation.quotaExhausted) {
						responseObservation = retryObservation;
						responseTime = retryResponseTime;
						break;
					}
					response = undefined;
					retryUsed = true;
				}
			}

			responseTime ??= this.now();
			const observation =
				responseObservation ??
				observeResponse(response, responseTime, {
					...state,
					pollNotBeforeMs,
				});
			state.rateLimitNotBeforeMs =
				observation.boundary.rateLimitNotBeforeMs;
			if (observation.failure !== undefined)
				return observation.failure.scope === 'provider'
					? resultProviderFailure(observation.failure.failure, {
							...observation.boundary,
							pollNotBeforeMs,
						})
					: resultPersonFailure(observation.failure.failure, {
							...observation.boundary,
							pollNotBeforeMs,
						});
			if (response.status !== 200) {
				const classified = classifyUnexpectedResponse(
					response,
					responseTime,
					{
						...observation.boundary,
						pollNotBeforeMs,
					},
				);
				return classified.failure.scope === 'provider'
					? resultProviderFailure(
							classified.failure.value,
							classified.state,
						)
					: resultPersonFailure(
							classified.failure.value,
							classified.state,
						);
			}

			const nextPollNotBeforeMs = parsePollInterval(
				response,
				responseTime,
			);
			if (nextPollNotBeforeMs === undefined)
				return resultPersonFailure(
					failure(
						'malformed-provider-data',
						'missing or malformed poll interval',
					),
					{ ...observation.boundary, pollNotBeforeMs },
				);
			pollNotBeforeMs = maxBoundary(pollNotBeforeMs, nextPollNotBeforeMs);
			if (!Array.isArray(response.json))
				return resultPersonFailure(
					failure(
						'malformed-provider-data',
						'malformed GitHub Events page',
					),
					{ ...observation.boundary, pollNotBeforeMs },
				);

			let detailQuotaExhausted = false;
			for (const event of response.json) {
				let mapped = mapEvent(
					event,
					input.username,
					input.githubAccountId,
				);
				if (mapped.kind === 'invalid')
					return resultPersonFailure(
						failure(
							'malformed-provider-data',
							'malformed supported GitHub event',
						),
						{ ...observation.boundary, pollNotBeforeMs },
					);
				if (mapped.kind === 'identity-mismatch')
					return resultPersonFailure(
						failure(
							'identity-mismatch',
							'GitHub event actor does not match followed person',
						),
						{ ...observation.boundary, pollNotBeforeMs },
					);
				if (mapped.kind === 'pull-request-needs-details') {
					if (observation.quotaExhausted || detailQuotaExhausted)
						return resultProviderFailure(
							failure(
								'rate-limit',
								'quota boundary prevents complete Events retrieval',
							),
							{ ...state, pollNotBeforeMs },
						);
					const details = await this.retrievePullRequestDetails(
						mapped.url,
						mapped.eventAction,
						mapped.requiresMerged,
						{ ...state, pollNotBeforeMs },
						retryUsed,
					);
					state.rateLimitNotBeforeMs =
						details.state.rateLimitNotBeforeMs;
					pollNotBeforeMs = maxBoundary(
						pollNotBeforeMs,
						details.state.pollNotBeforeMs,
					);
					retryUsed = details.retryUsed;
					detailQuotaExhausted ||= details.quotaExhausted;
					if (details.kind === 'failure')
						return details.scope === 'provider'
							? resultProviderFailure(details.failure, {
									...details.state,
									pollNotBeforeMs,
								})
							: resultPersonFailure(details.failure, {
									...details.state,
									pollNotBeforeMs,
								});
					const activity = createPullRequestActivity({
						...mapped.envelope,
						number: mapped.number,
						title: details.title,
						action:
							mapped.normalizedAction ??
							(details.merged ? 'merged' : 'closed'),
					});
					if (!activity.ok)
						return resultPersonFailure(
							failure(
								'malformed-provider-data',
								'malformed GitHub pull request response',
							),
							{ ...state, pollNotBeforeMs },
						);
					mapped = { kind: 'activity', activity: activity.value };
				}
				if (mapped.kind !== 'activity') continue;
				const existing = activities.get(
					mapped.activity.providerEventId,
				);
				if (existing !== undefined) {
					if (!hasSameActivity(existing, mapped.activity))
						return resultPersonFailure(
							failure(
								'malformed-provider-data',
								'conflicting duplicate GitHub event',
							),
							{ ...observation.boundary, pollNotBeforeMs },
						);
					continue;
				}
				activities.set(
					mapped.activity.providerEventId,
					mapped.activity,
				);
			}

			const currentState = { ...state, pollNotBeforeMs };

			const next = parseNextPage(
				response,
				input.username,
				input.githubAccountId,
				page,
			);
			if (!next.ok)
				return resultPersonFailure(
					failure(
						'pagination',
						'invalid GitHub Events pagination link',
					),
					currentState,
				);
			if (next.next === undefined)
				return resultSuccess(
					{ activities: [...activities.values()] },
					currentState,
				);
			if (page >= MAX_EVENTS_PAGES)
				return resultProviderFailure(
					failure(
						'pagination',
						'GitHub Events page ceiling exceeded',
					),
					currentState,
				);
			if (observation.quotaExhausted || detailQuotaExhausted)
				return resultProviderFailure(
					failure(
						'rate-limit',
						'quota boundary prevents complete Events retrieval',
					),
					currentState,
				);
			page = next.next.page;
			url = next.next.url;
		}
	}
}
