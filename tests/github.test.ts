import { describe, expect, it } from 'vitest';
import {
	GitHubAdapter,
	GitHubTransportContractError,
	type GitHubTransport,
	type GitHubTransportRequest,
	type GitHubTransportResponse,
} from '../src/adapters/github';

const NOW = Date.parse('2026-08-21T00:00:00.000Z');
const USERNAME = 'octocat';
const ACCOUNT_ID = '42';

function response(
	json: unknown,
	overrides: Partial<GitHubTransportResponse> = {},
): GitHubTransportResponse {
	return {
		status: 200,
		json,
		...overrides,
		headers: {
			'x-poll-interval': '60',
			'x-ratelimit-remaining': '10',
			...overrides.headers,
		},
	};
}

function identity(overrides: Record<string, unknown> = {}) {
	return {
		login: USERNAME,
		id: Number(ACCOUNT_ID),
		type: 'User',
		...overrides,
	};
}

function event(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: '1',
		type: 'PushEvent',
		created_at: '2026-08-20T12:00:00Z',
		repo: { name: 'octocat/hello-world' },
		actor: { id: Number(ACCOUNT_ID), login: USERNAME },
		payload: { ref: 'refs/heads/main', head: 'a'.repeat(40) },
		...overrides,
	};
}

function requestRecorder(responses: Array<GitHubTransportResponse | Error>): {
	readonly transport: GitHubTransport;
	readonly requests: GitHubTransportRequest[];
} {
	const requests: GitHubTransportRequest[] = [];
	let index = 0;
	return {
		requests,
		transport: async (request) => {
			requests.push(request);
			const next = responses[index++];
			if (next === undefined) throw new Error('unexpected request');
			if (next instanceof Error) throw next;
			return next;
		},
	};
}

function adapter(
	responses: Array<GitHubTransportResponse | Error>,
	now: () => number = () => NOW,
) {
	const recorder = requestRecorder(responses);
	return {
		adapter: new GitHubAdapter({
			pluginVersion: '0.2.0-test',
			transport: recorder.transport,
			now,
		}),
		requests: recorder.requests,
	};
}

function eventsRequest() {
	return {
		username: USERNAME,
		githubAccountId: ACCOUNT_ID,
	};
}

describe('GitHub adapter request and identity boundaries', () => {
	it('builds exact unauthenticated requests with the supplied plugin version', async () => {
		const { adapter: github, requests } = adapter([response(identity())]);
		const result = await github.resolveIdentity({ username: USERNAME });

		expect(result.kind).toBe('success');
		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual({
			url: 'https://api.github.com/users/octocat',
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent':
					'DevRadar/0.2.0-test (https://github.com/FerdiHS/devradar)',
				'X-GitHub-Api-Version': '2026-03-10',
			},
		});
	});

	it('fails closed on the redirect contract without retrying or attempting a request', async () => {
		let transportCalls = 0;
		const result = await new GitHubAdapter({
			pluginVersion: '0.2.0-test',
			transport: async () => {
				transportCalls += 1;
				throw new GitHubTransportContractError(
					'redirect contract blocked',
				);
			},
			now: () => NOW,
		}).retrieveEvents(eventsRequest());

		expect(result).toMatchObject({
			kind: 'provider-failure',
			requestAttempted: false,
			failure: {
				category: 'redirect-contract',
				message: 'redirect contract blocked',
			},
		});
		expect(transportCalls).toBe(1);
	});

	it('builds the Events request with the same exact headers and page size', async () => {
		const { adapter: github, requests } = adapter([response([event()])]);
		const result = await github.retrieveEvents(eventsRequest());

		expect(result.kind).toBe('success');
		expect(requests[0]).toEqual({
			url: 'https://api.github.com/users/octocat/events/public?per_page=100',
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent':
					'DevRadar/0.2.0-test (https://github.com/FerdiHS/devradar)',
				'X-GitHub-Api-Version': '2026-03-10',
			},
		});
	});

	it('rejects invalid draft/followed identities without a request', async () => {
		const invalidDraft = adapter([]);
		const draftResult = await invalidDraft.adapter.resolveIdentity({
			username: 'bad--login',
		});
		const invalidFollowed = adapter([]);
		const followedResult = await invalidFollowed.adapter.retrieveEvents({
			...eventsRequest(),
			githubAccountId: '01',
		});

		expect(draftResult).toMatchObject({
			kind: 'person-failure',
			requestAttempted: false,
			failure: { category: 'invalid-input' },
		});
		expect(followedResult).toMatchObject({
			kind: 'person-failure',
			requestAttempted: false,
			failure: { category: 'invalid-input' },
		});
		expect(invalidDraft.requests).toHaveLength(0);
		expect(invalidFollowed.requests).toHaveLength(0);
	});

	it('blocks identity and Events requests at provider-policy boundaries', async () => {
		const boundary = '2026-08-21T01:00:00.000Z';
		const identityCase = adapter([]);
		const identityResult = await identityCase.adapter.resolveIdentity({
			username: USERNAME,
			globalPolicy: { rateLimitNotBefore: boundary },
		});
		const eventsCase = adapter([]);
		const eventsResult = await eventsCase.adapter.retrieveEvents({
			...eventsRequest(),
			pollNotBefore: boundary,
		});

		expect(identityResult).toMatchObject({
			kind: 'no-request',
			requestAttempted: false,
			notBefore: boundary,
		});
		expect(eventsResult).toMatchObject({
			kind: 'no-request',
			requestAttempted: false,
			notBefore: boundary,
		});
		expect(identityCase.requests).toHaveLength(0);
		expect(eventsCase.requests).toHaveLength(0);
	});

	it('allows requests once supplied provider-policy boundaries are reached', async () => {
		const reached = new Date(NOW - 1).toISOString();
		const identityCase = adapter([response(identity())]);
		const identityResult = await identityCase.adapter.resolveIdentity({
			username: USERNAME,
			globalPolicy: { rateLimitNotBefore: reached },
		});
		const eventsCase = adapter([response([event()])]);
		const eventsResult = await eventsCase.adapter.retrieveEvents({
			...eventsRequest(),
			globalPolicy: { rateLimitNotBefore: reached },
			pollNotBefore: reached,
		});

		expect(identityResult.kind).toBe('success');
		expect(eventsResult.kind).toBe('success');
		expect(identityCase.requests).toHaveLength(1);
		expect(eventsCase.requests).toHaveLength(1);
	});

	it('classifies invalid global and person policy boundaries by scope', async () => {
		const invalidGlobal = adapter([]);
		const invalidGlobalResult = await invalidGlobal.adapter.resolveIdentity(
			{
				username: USERNAME,
				globalPolicy: { rateLimitNotBefore: '2026-08-21' },
			},
		);
		expect(invalidGlobalResult).toMatchObject({
			kind: 'provider-failure',
			requestAttempted: false,
			failure: { category: 'invalid-policy' },
		});

		const invalidPerson = adapter([]);
		const invalidPersonResult = await invalidPerson.adapter.retrieveEvents({
			...eventsRequest(),
			pollNotBefore: '2026-08-21',
		});
		expect(invalidPersonResult).toMatchObject({
			kind: 'person-failure',
			requestAttempted: false,
			failure: { category: 'invalid-policy' },
		});

		const invalidEventsGlobal = adapter([]);
		const invalidEventsGlobalResult =
			await invalidEventsGlobal.adapter.retrieveEvents({
				...eventsRequest(),
				globalPolicy: { rateLimitNotBefore: '2026-08-21' },
			});
		expect(invalidEventsGlobalResult).toMatchObject({
			kind: 'provider-failure',
			requestAttempted: false,
			failure: { category: 'invalid-policy' },
		});
	});

	it('accepts only canonical User identities and safe IDs', async () => {
		for (const invalid of [
			{ id: 0 },
			{ id: -1 },
			{ id: 1.5 },
			{ id: Number.MAX_SAFE_INTEGER + 1 },
			{ id: '01' },
			{ id: '0' },
			{ type: 'Organization' },
			{ login: 'bad--login' },
		]) {
			const { adapter: github } = adapter([response(identity(invalid))]);
			const result = await github.resolveIdentity({ username: USERNAME });
			expect(result.kind).toBe('person-failure');
		}
		const unsafeStringId = adapter([
			response(identity({ id: '9007199254740993' })),
		]);
		const unsafeStringResult = await unsafeStringId.adapter.resolveIdentity(
			{
				username: USERNAME,
			},
		);
		expect(unsafeStringResult).toMatchObject({
			kind: 'person-failure',
			failure: { category: 'malformed-provider-data' },
		});

		const eventId = adapter([
			response([event({ id: '9007199254740993' })]),
		]);
		const eventIdResult =
			await eventId.adapter.retrieveEvents(eventsRequest());
		expect(eventIdResult).toMatchObject({
			kind: 'success',
			data: {
				activities: [{ providerEventId: '9007199254740993' }],
			},
		});
	});

	it('uses one retry total for identity transport failures', async () => {
		const { adapter: github, requests } = adapter([
			new Error('temporary transport failure'),
			response(identity()),
		]);
		const result = await github.resolveIdentity({ username: USERNAME });

		expect(result.kind).toBe('success');
		expect(requests).toHaveLength(2);

		const quota = adapter([
			response(
				{ message: 'temporary' },
				{
					status: 503,
					headers: {
						'x-ratelimit-remaining': '0',
						'x-ratelimit-reset': String((NOW + 120_000) / 1000),
					},
				},
			),
			response(identity()),
		]);
		const quotaResult = await quota.adapter.resolveIdentity({
			username: USERNAME,
		});
		expect(quotaResult).toMatchObject({
			kind: 'person-failure',
			policy: {
				rateLimitNotBefore: new Date(NOW + 120_000).toISOString(),
			},
		});
		expect(quota.requests).toHaveLength(1);
	});

	it('uses one response timestamp when quota exhaustion stops a 5xx retry', async () => {
		const identityTimes = [NOW, NOW + 1_000, NOW + 2_000];
		const identityCase = adapter(
			[
				response(
					{ message: 'temporary' },
					{ status: 503, headers: { 'x-ratelimit-remaining': '0' } },
				),
			],
			() => identityTimes.shift() ?? NOW,
		);
		const identityResult = await identityCase.adapter.resolveIdentity({
			username: USERNAME,
		});
		expect(identityResult.policy.rateLimitNotBefore).toBe(
			new Date(NOW + 1_000 + 60 * 60 * 1_000).toISOString(),
		);

		const eventsTimes = [NOW, NOW + 1_000, NOW + 2_000];
		const eventsCase = adapter(
			[
				response(
					{ message: 'temporary' },
					{ status: 503, headers: { 'x-ratelimit-remaining': '0' } },
				),
			],
			() => eventsTimes.shift() ?? NOW,
		);
		const eventsResult =
			await eventsCase.adapter.retrieveEvents(eventsRequest());
		expect(eventsResult.policy.rateLimitNotBefore).toBe(
			new Date(NOW + 1_000 + 60 * 60 * 1_000).toISOString(),
		);
	});

	it('samples identity response time once for status classification', async () => {
		let nowCalls = 0;
		const { adapter: github } = adapter(
			[response({}, { status: 404 })],
			() => {
				nowCalls += 1;
				return NOW;
			},
		);

		const result = await github.resolveIdentity({ username: USERNAME });

		expect(result).toMatchObject({
			kind: 'person-failure',
			failure: { category: 'not-found' },
		});
		expect(nowCalls).toBe(2);
	});

	it('persists a conservative boundary after successful zero-quota identity response', async () => {
		const { adapter: github } = adapter([
			response(identity(), {
				headers: { 'x-ratelimit-remaining': '0' },
			}),
		]);
		const result = await github.resolveIdentity({ username: USERNAME });

		expect(result).toMatchObject({
			kind: 'success',
			policy: {
				rateLimitNotBefore: new Date(
					NOW + 60 * 60 * 1000,
				).toISOString(),
			},
		});
	});

	it('keeps identity status failures person-scoped and rate limits provider-scoped', async () => {
		const notFound = adapter([response({}, { status: 404 })]);
		const notFoundResult = await notFound.adapter.resolveIdentity({
			username: USERNAME,
		});
		expect(notFoundResult).toMatchObject({
			kind: 'person-failure',
			failure: { category: 'not-found' },
		});

		const rateLimited = adapter([
			response(
				{},
				{
					status: 429,
					headers: {
						'x-ratelimit-remaining': '0',
						'x-ratelimit-reset': String((NOW + 60_000) / 1000),
					},
				},
			),
		]);
		const rateLimitedResult = await rateLimited.adapter.resolveIdentity({
			username: USERNAME,
		});
		expect(rateLimitedResult).toMatchObject({
			kind: 'provider-failure',
			failure: { category: 'rate-limit' },
		});
	});
});

describe('GitHub Events validation and mapping', () => {
	it('maps Push, Pull Request, and Issue events through the domain', async () => {
		const pullRequest = event({
			id: '2',
			type: 'PullRequestEvent',
			payload: {
				action: 'closed',
				number: 4,
				pull_request: { title: 'Improve docs', merged: true },
			},
		});
		const issue = event({
			id: '3',
			type: 'IssuesEvent',
			payload: {
				action: 'opened',
				issue: { number: 5, title: 'Fix bug' },
			},
		});
		const { adapter: github } = adapter([
			response([
				event({
					payload: {
						ref: 'refs/heads/main',
						head: 'a'.repeat(40),
						before: 123,
					},
				}),
				pullRequest,
				issue,
			]),
		]);

		const result = await github.retrieveEvents(eventsRequest());

		expect(result.kind).toBe('success');
		if (result.kind !== 'success') return;
		expect(result.data.activities).toEqual([
			{
				family: 'push',
				action: 'pushed',
				providerEventId: '1',
				timestamp: '2026-08-20T12:00:00Z',
				repository: 'octocat/hello-world',
				ref: 'refs/heads/main',
				pushSourceUrl: `https://github.com/octocat/hello-world/commit/${'a'.repeat(40)}`,
			},
			{
				family: 'pull-request',
				action: 'merged',
				providerEventId: '2',
				timestamp: '2026-08-20T12:00:00Z',
				repository: 'octocat/hello-world',
				number: '4',
				title: 'Improve docs',
				sourceUrl: 'https://github.com/octocat/hello-world/pull/4',
			},
			{
				family: 'issue',
				action: 'opened',
				providerEventId: '3',
				timestamp: '2026-08-20T12:00:00Z',
				repository: 'octocat/hello-world',
				number: '5',
				title: 'Fix bug',
				sourceUrl: 'https://github.com/octocat/hello-world/issues/5',
			},
		]);

		const caseOnly = adapter([
			response([
				event({ actor: { id: Number(ACCOUNT_ID), login: 'Octocat' } }),
			]),
		]);
		const caseOnlyResult =
			await caseOnly.adapter.retrieveEvents(eventsRequest());
		expect(caseOnlyResult).toMatchObject({ kind: 'success' });
	});

	it('handles every supported PR merge condition and Issue action', async () => {
		const events = [
			['opened', undefined],
			['reopened', undefined],
			['closed', false],
			['closed', true],
			['merged', true],
		].map(([action, merged], index) =>
			event({
				id: String(index + 1),
				type: 'PullRequestEvent',
				payload: {
					action,
					number: index + 1,
					pull_request: {
						title: 'Title',
						...(merged === undefined ? {} : { merged }),
					},
				},
			}),
		);
		const issueEvents = ['opened', 'reopened', 'closed'].map(
			(action, index) =>
				event({
					id: String(index + 10),
					type: 'IssuesEvent',
					payload: {
						action,
						issue: { number: index + 10, title: 'Issue' },
					},
				}),
		);
		const { adapter: github } = adapter([
			response([...events, ...issueEvents]),
		]);

		const result = await github.retrieveEvents(eventsRequest());

		expect(result.kind).toBe('success');
		if (result.kind !== 'success') return;
		expect(result.data.activities).toHaveLength(8);
		expect(
			result.data.activities
				.slice(0, 5)
				.map((activity) => activity.action),
		).toEqual(['opened', 'reopened', 'closed', 'merged', 'merged']);
	});

	it('ignores valid known events with unsupported actions', async () => {
		const { adapter: github } = adapter([
			response([
				event({
					type: 'PullRequestEvent',
					payload: {
						action: 'assigned',
						number: 4,
						pull_request: { title: 'Title', merged: false },
					},
				}),
				event({
					type: 'IssuesEvent',
					payload: {
						action: 'labeled',
						issue: { number: 5, title: 'Issue' },
					},
				}),
			]),
		]);

		const result = await github.retrieveEvents(eventsRequest());
		expect(result).toMatchObject({
			kind: 'success',
			data: { activities: [] },
		});
	});

	it('ignores structurally valid unknown/deferred events without over-validation', async () => {
		const { adapter: github } = adapter([
			response([
				{ type: 'PullRequestReviewEvent' },
				{ type: 'FutureEvent' },
			]),
		]);
		const result = await github.retrieveEvents(eventsRequest());
		expect(result).toMatchObject({
			kind: 'success',
			data: { activities: [] },
		});
	});

	it('fails malformed entries and supported events instead of hiding them', async () => {
		for (const page of [
			[null],
			[{ type: '' }],
			[{ type: '   ' }],
			[{ type: 'Future Event' }],
			[{ type: 'Future\u0000Event' }],
			[event({ payload: {} })],
			[event({ type: 'PullRequestEvent', payload: { action: ' ' } })],
			[
				event({
					type: 'PullRequestEvent',
					payload: { action: 'opened\u0000' },
				}),
			],
			[
				event({
					type: 'PullRequestEvent',
					payload: { action: ' opened ' },
				}),
			],
			[event({ actor: { id: 999, login: USERNAME } })],
			[
				event({
					type: 'PullRequestEvent',
					payload: {
						action: 'closed',
						number: 4,
						pull_request: { title: 'Title', merged: 'yes' },
					},
				}),
			],
		]) {
			const { adapter: github } = adapter([response(page)]);
			const result = await github.retrieveEvents(eventsRequest());
			expect(result.kind).toBe('person-failure');
		}

		const mismatch = adapter([
			response([event({ actor: { id: 999, login: USERNAME } })]),
		]);
		const mismatchResult =
			await mismatch.adapter.retrieveEvents(eventsRequest());
		expect(mismatchResult).toMatchObject({
			kind: 'person-failure',
			failure: { category: 'identity-mismatch' },
		});
	});
});

describe('GitHub Events pagination and completeness', () => {
	it('retrieves at most three pages and rejects a page-four link', async () => {
		const pageLink = (page: number) =>
			`<https://api.github.com/users/${USERNAME}/events/public?page=${page}&per_page=100>; rel="next"`;
		const { adapter: github, requests } = adapter([
			response([event()], { headers: { link: pageLink(2) } }),
			response([event({ id: '2' })], { headers: { link: pageLink(3) } }),
			response([event({ id: '3' })], { headers: { link: pageLink(4) } }),
		]);

		const result = await github.retrieveEvents(eventsRequest());

		expect(result).toMatchObject({
			kind: 'provider-failure',
			failure: { category: 'pagination' },
		});
		expect(requests).toHaveLength(3);
	});

	it('rejects untrusted, skipped, duplicated, and drifting next links', async () => {
		const links = [
			'<https://evil.example/users/octocat/events/public?page=2&per_page=100>; rel="next"',
			'<https://api.github.com/users/octocat/events/public?page=2&per_page=100> rel="next"',
			'<https://api.github.com/users/octocat/events/public?page=2&per_page=100>; rel="next"; garbage',
			'<https://api.github.com/users/octocat/events/public?page=2&per_page=100>; rel="next!"',
			'<https://api.github.com\\users/octocat/events/public?page=2&per_page=100>; rel="next"',
			'< https://api.github.com/users/octocat/events/public?page=2&per_page=100>; rel="next"',
			'<https://api.github.com/users/octocat/events/public?page=2&per_page=100 >; rel="next"',
			'<https://api.github.com/users/octocat/users/../events/public?page=2&per_page=100>; rel="next"',
			'<https://api.github.com/users/octocat/events/public?page=2&per_page=100>; rel=" next"',
			'<https://api.github.com/users/octocat/events/public?page=2&per_page=100>; rel="next\tprev"',
			'<https://api.github.com/users/octocat/events/public?page=2&per_page=100>; rel=""',
			'<https://api.github.com/users/octocat/events/public?page=3&per_page=100>; rel="next"',
			'<https://api.github.com/users/octocat/events/public?page=2&per_page=100>; rel="next", <https://api.github.com/users/octocat/events/public?page=2&per_page=100>; rel="next"',
			'<https://api.github.com/users/octocat/events/public?page=2&per_page=99>; rel="next"',
			'<https://api.github.com/users/octocat/events/public?page=2&per_page=100&x=1>; rel="next"',
			'<https://api.github.com/users/other/events/public?page=2&per_page=100>; rel="next"',
			'<https://api.github.com/repos/octocat/hello-world?page=2&per_page=100>; rel="next"',
			'<https://user:pass@api.github.com/users/octocat/events/public?page=2&per_page=100>; rel="next"',
			'<https://api.github.com/users/octocat/events/public?page=2&per_page=100#fragment>; rel="next"',
			'<https://api.github.com/users/octocat/events/public?page=2&per_page=100#>; rel="next"',
			'<https://api.github.com/users/octocat/events/public?page=2&page=2&per_page=100>; rel="next"',
			'<https://api.github.com/users/octocat/events/public?page=1&per_page=100>; rel="next"',
		];
		for (const link of links) {
			const { adapter: github } = adapter([
				response([event()], { headers: { link } }),
			]);
			const result = await github.retrieveEvents(eventsRequest());
			expect(result).toMatchObject({
				kind: 'person-failure',
				failure: { category: 'pagination' },
			});
		}
	});

	it('rejects anchored next links without following them', async () => {
		const link = `<https://api.github.com/users/${USERNAME}/events/public?page=2&per_page=100>; rel="next"; anchor="https://example.com/something"`;
		const { adapter: github, requests } = adapter([
			response([event()], { headers: { link } }),
		]);

		const result = await github.retrieveEvents(eventsRequest());
		expect(result).toMatchObject({
			kind: 'person-failure',
			failure: { category: 'pagination' },
		});
		expect(requests).toHaveLength(1);
	});

	it('completes valid two- and three-page retrievals', async () => {
		const pageLink = (page: number) =>
			`<https://api.github.com/users/${USERNAME}/events/public?page=${page}&per_page=100>; rel="next"`;
		const caseInsensitive = adapter([
			response([event()], {
				headers: {
					link: `<https://api.github.com/users/${USERNAME}/events/public?page=2&per_page=100>; rel="NEXT"`,
				},
			}),
			response([event({ id: '2' })]),
		]);
		const caseInsensitiveResult =
			await caseInsensitive.adapter.retrieveEvents(eventsRequest());
		expect(caseInsensitiveResult).toMatchObject({ kind: 'success' });
		expect(caseInsensitive.requests).toHaveLength(2);

		const quotedPair = adapter([
			response([event()], {
				headers: {
					link: `<https://api.github.com/users/${USERNAME}/events/public?page=2&per_page=100>; rel="n\\ext"`,
				},
			}),
			response([event({ id: '2' })]),
		]);
		const quotedPairResult =
			await quotedPair.adapter.retrieveEvents(eventsRequest());
		expect(quotedPairResult).toMatchObject({ kind: 'success' });
		expect(quotedPair.requests).toHaveLength(2);

		const twoPage = adapter([
			response([event()], { headers: { link: pageLink(2) } }),
			response([event({ id: '2' })]),
		]);
		const twoPageResult =
			await twoPage.adapter.retrieveEvents(eventsRequest());
		expect(twoPageResult).toMatchObject({ kind: 'success' });
		expect(twoPage.requests).toHaveLength(2);

		const threePage = adapter([
			response([event()], { headers: { link: pageLink(2) } }),
			response([event({ id: '2' })], { headers: { link: pageLink(3) } }),
			response([event({ id: '3' })]),
		]);
		const threePageResult =
			await threePage.adapter.retrieveEvents(eventsRequest());
		expect(threePageResult).toMatchObject({ kind: 'success' });
		expect(threePage.requests).toHaveLength(3);
	});

	it('does not return partial activities after a later-page failure', async () => {
		const link = `<https://api.github.com/users/${USERNAME}/events/public?page=2&per_page=100>; rel="next"`;
		const { adapter: github } = adapter([
			response([event()], { headers: { link } }),
			response({ message: 'temporary' }, { status: 503 }),
			response({ message: 'still temporary' }, { status: 503 }),
		]);
		const result = await github.retrieveEvents(eventsRequest());
		expect(result.kind).toBe('person-failure');
	});

	it('shares the Events retry budget across pages', async () => {
		const link = `<https://api.github.com/users/${USERNAME}/events/public?page=2&per_page=100>; rel="next"`;
		const { adapter: github, requests } = adapter([
			response([event()], { status: 503, headers: { link } }),
			response([event()], { headers: { link } }),
			response({ message: 'still temporary' }, { status: 503 }),
		]);
		const result = await github.retrieveEvents(eventsRequest());

		expect(result).toMatchObject({ kind: 'person-failure' });
		expect(requests).toHaveLength(3);
	});

	it('stops after a transient Events failure establishes a quota-zero boundary', async () => {
		const { adapter: github, requests } = adapter([
			response(
				{ message: 'temporary' },
				{
					status: 503,
					headers: {
						'x-ratelimit-remaining': '0',
						'x-ratelimit-reset': String((NOW + 120_000) / 1000),
					},
				},
			),
			response([event()]),
		]);

		const result = await github.retrieveEvents(eventsRequest());

		expect(result).toMatchObject({
			kind: 'person-failure',
			policy: {
				rateLimitNotBefore: new Date(NOW + 120_000).toISOString(),
			},
		});
		expect(requests).toHaveLength(1);
	});

	it('collapses equal duplicates and rejects conflicting duplicates', async () => {
		const same = event();
		const equalCase = adapter([response([same, same])]);
		const equalResult =
			await equalCase.adapter.retrieveEvents(eventsRequest());
		expect(equalResult).toMatchObject({
			kind: 'success',
			data: { activities: [expect.anything()] },
		});

		const conflictCase = adapter([
			response([
				event(),
				event({ payload: { ref: 'refs/heads/other' } }),
			]),
		]);
		const conflictResult =
			await conflictCase.adapter.retrieveEvents(eventsRequest());
		expect(conflictResult).toMatchObject({
			kind: 'person-failure',
			failure: { category: 'malformed-provider-data' },
		});

		const link = `<https://api.github.com/users/${USERNAME}/events/public?page=2&per_page=100>; rel="next"`;
		const crossPageEqual = adapter([
			response([same], { headers: { link } }),
			response([same]),
		]);
		const crossPageEqualResult =
			await crossPageEqual.adapter.retrieveEvents(eventsRequest());
		expect(crossPageEqualResult).toMatchObject({
			kind: 'success',
			data: { activities: [expect.anything()] },
		});

		const crossPageConflict = adapter([
			response([same], { headers: { link } }),
			response([event({ payload: { ref: 'refs/heads/other' } })]),
		]);
		const crossPageConflictResult =
			await crossPageConflict.adapter.retrieveEvents(eventsRequest());
		expect(crossPageConflictResult).toMatchObject({
			kind: 'person-failure',
			failure: { category: 'malformed-provider-data' },
		});
	});
});

describe('GitHub policy and status handling', () => {
	it('uses observation-time poll boundaries and preserves the maximum', async () => {
		const times = [NOW, NOW, NOW + 10_000];
		const { adapter: github } = adapter(
			[
				response([event()], {
					headers: {
						'x-poll-interval': '120',
						link: `<https://api.github.com/users/${USERNAME}/events/public?page=2&per_page=100>; rel="next"`,
					},
				}),
				response([event({ id: '2' })], {
					headers: { 'x-poll-interval': '1' },
				}),
			],
			() => times.shift() ?? NOW,
		);
		const result = await github.retrieveEvents(eventsRequest());
		expect(result).toMatchObject({
			kind: 'success',
			policy: { pollNotBefore: new Date(NOW + 120_000).toISOString() },
		});
	});

	it('fails closed on missing or malformed poll intervals', async () => {
		for (const value of [
			undefined,
			'-1',
			'1.5',
			'abc',
			'253402300800',
			String(Number.MAX_SAFE_INTEGER),
		]) {
			const headers =
				value === undefined
					? { 'x-poll-interval': undefined }
					: { 'x-poll-interval': value };
			const { adapter: github } = adapter([
				response([event()], {
					headers: headers as Record<string, string>,
				}),
			]);
			const result = await github.retrieveEvents(eventsRequest());
			expect(result).toMatchObject({
				kind: 'person-failure',
				failure: { category: 'malformed-provider-data' },
			});
		}
	});

	it('classifies primary, secondary, and ordinary 403/429 responses conservatively', async () => {
		const primary = adapter([
			response(
				{ message: 'limit' },
				{
					status: 403,
					headers: {
						'x-ratelimit-remaining': '0',
						'x-ratelimit-reset': String((NOW + 120_000) / 1000),
						'retry-after': '300',
					},
				},
			),
		]);
		const primaryResult =
			await primary.adapter.retrieveEvents(eventsRequest());
		expect(primaryResult).toMatchObject({
			kind: 'provider-failure',
			failure: { category: 'rate-limit' },
		});
		expect(primaryResult.policy.rateLimitNotBefore).toBe(
			new Date(NOW + 300_000).toISOString(),
		);

		for (const reset of [
			undefined,
			'not-an-epoch',
			String((NOW - 120_000) / 1000),
			'253402300800',
			String(Number.MAX_SAFE_INTEGER),
		]) {
			const headers: Record<string, string> = {
				'x-ratelimit-remaining': '0',
				'retry-after': '300',
			};
			if (reset !== undefined) headers['x-ratelimit-reset'] = reset;
			const missingReset = adapter([
				response({ message: 'limit' }, { status: 403, headers }),
			]);
			const missingResetResult =
				await missingReset.adapter.retrieveEvents(eventsRequest());
			expect(missingResetResult.policy.rateLimitNotBefore).toBe(
				new Date(NOW + 60 * 60 * 1000).toISOString(),
			);
		}

		for (const retryAfter of ['1.5', String(Number.MAX_SAFE_INTEGER)]) {
			const invalidRetryAfter = adapter([
				response(
					{ message: 'forbidden' },
					{
						status: 403,
						headers: { 'retry-after': retryAfter },
					},
				),
			]);
			const invalidRetryAfterResult =
				await invalidRetryAfter.adapter.retrieveEvents(eventsRequest());
			expect(invalidRetryAfterResult.policy.rateLimitNotBefore).toBe(
				new Date(NOW + 60 * 60 * 1000).toISOString(),
			);
		}

		const secondary = adapter([
			response(
				{ message: 'You have exceeded a secondary rate limit.' },
				{ status: 403 },
			),
		]);
		const secondaryResult =
			await secondary.adapter.retrieveEvents(eventsRequest());
		expect(secondaryResult).toMatchObject({
			kind: 'provider-failure',
			failure: { category: 'rate-limit' },
		});
		expect(secondaryResult.policy.rateLimitNotBefore).toBe(
			new Date(NOW + 60_000).toISOString(),
		);

		for (const message of [
			'This is not a secondary rate limit.',
			'Secondary rate limit information is available.',
			'You have not exceeded a secondary rate limit.',
			'If you have exceeded a secondary rate limit, wait.',
		]) {
			const ambiguous = adapter([response({ message }, { status: 403 })]);
			const ambiguousResult =
				await ambiguous.adapter.retrieveEvents(eventsRequest());
			expect(ambiguousResult.policy.rateLimitNotBefore).toBe(
				new Date(NOW + 60 * 60 * 1_000).toISOString(),
			);
		}

		const secondaryWithPrimaryReset = adapter([
			response(
				{ message: 'You have exceeded a secondary rate limit.' },
				{
					status: 403,
					headers: {
						'x-ratelimit-remaining': '10',
						'x-ratelimit-reset': String(
							(NOW + 60 * 60 * 1000) / 1000,
						),
					},
				},
			),
		]);
		const secondaryWithPrimaryResetResult =
			await secondaryWithPrimaryReset.adapter.retrieveEvents(
				eventsRequest(),
			);
		expect(secondaryWithPrimaryResetResult.policy.rateLimitNotBefore).toBe(
			new Date(NOW + 60_000).toISOString(),
		);

		const retryAfter = adapter([
			response(
				{ message: 'forbidden' },
				{
					status: 429,
					headers: {
						'x-ratelimit-remaining': '10',
						'x-ratelimit-reset': String(
							(NOW + 60 * 60 * 1000) / 1000,
						),
						'retry-after': '90',
					},
				},
			),
		]);
		const retryAfterResult =
			await retryAfter.adapter.retrieveEvents(eventsRequest());
		expect(retryAfterResult).toMatchObject({
			kind: 'provider-failure',
			failure: { category: 'rate-limit' },
		});
		expect(retryAfterResult.policy.rateLimitNotBefore).toBe(
			new Date(NOW + 90_000).toISOString(),
		);

		const zeroRetryAfter = adapter([
			response(
				{ message: 'forbidden' },
				{ status: 429, headers: { 'retry-after': '0' } },
			),
		]);
		const zeroRetryAfterResult =
			await zeroRetryAfter.adapter.retrieveEvents(eventsRequest());
		expect(zeroRetryAfterResult).toMatchObject({
			kind: 'provider-failure',
			failure: { category: 'rate-limit' },
			policy: { rateLimitNotBefore: new Date(NOW).toISOString() },
		});

		const ordinary = adapter([
			response({ message: 'forbidden' }, { status: 403 }),
		]);
		const ordinaryResult =
			await ordinary.adapter.retrieveEvents(eventsRequest());
		expect(ordinaryResult).toMatchObject({
			kind: 'provider-failure',
			failure: { category: 'rate-limit' },
		});
		expect(ordinaryResult.policy.rateLimitNotBefore).toBe(
			new Date(NOW + 60 * 60 * 1000).toISOString(),
		);
	});

	it('allows a final quota-zero page but never returns partial non-final retrieval', async () => {
		const finalCase = adapter([
			response([event()], {
				headers: {
					'x-ratelimit-remaining': '0',
					'x-ratelimit-reset': String((NOW + 120_000) / 1000),
				},
			}),
		]);
		const finalResult =
			await finalCase.adapter.retrieveEvents(eventsRequest());
		expect(finalResult).toMatchObject({
			kind: 'success',
			policy: {
				rateLimitNotBefore: new Date(NOW + 120_000).toISOString(),
			},
		});

		const finalWithoutTiming = adapter([
			response([event()], {
				headers: { 'x-ratelimit-remaining': '0' },
			}),
		]);
		const finalWithoutTimingResult =
			await finalWithoutTiming.adapter.retrieveEvents(eventsRequest());
		expect(finalWithoutTimingResult).toMatchObject({
			kind: 'success',
			policy: {
				rateLimitNotBefore: new Date(
					NOW + 60 * 60 * 1000,
				).toISOString(),
			},
		});

		const link = `<https://api.github.com/users/${USERNAME}/events/public?page=2&per_page=100>; rel="next"`;
		const nonFinalCase = adapter([
			response([event()], {
				headers: {
					link,
					'x-ratelimit-remaining': '0',
					'x-ratelimit-reset': String((NOW + 120_000) / 1000),
				},
			}),
		]);
		const nonFinalResult =
			await nonFinalCase.adapter.retrieveEvents(eventsRequest());
		expect(nonFinalResult).toMatchObject({
			kind: 'provider-failure',
			failure: { category: 'rate-limit' },
		});
		expect(nonFinalCase.requests).toHaveLength(1);

		const nonFinalWithoutTiming = adapter([
			response([event()], {
				headers: {
					link,
					'x-ratelimit-remaining': '0',
				},
			}),
		]);
		const nonFinalWithoutTimingResult =
			await nonFinalWithoutTiming.adapter.retrieveEvents(eventsRequest());
		expect(nonFinalWithoutTimingResult).toMatchObject({
			kind: 'provider-failure',
			failure: { category: 'rate-limit' },
			policy: {
				rateLimitNotBefore: new Date(
					NOW + 60 * 60 * 1000,
				).toISOString(),
			},
		});
		expect(nonFinalWithoutTiming.requests).toHaveLength(1);
	});

	it('does not retry 304 or ordinary 4xx and recognizes narrow API-version failures', async () => {
		const notModified = adapter([response({}, { status: 304 })]);
		const notModifiedResult =
			await notModified.adapter.retrieveEvents(eventsRequest());
		expect(notModifiedResult).toMatchObject({
			kind: 'person-failure',
			failure: { category: 'unexpected-not-modified' },
		});
		expect(notModified.requests).toHaveLength(1);

		const ordinary = adapter([response({}, { status: 400 })]);
		const ordinaryResult =
			await ordinary.adapter.retrieveEvents(eventsRequest());
		expect(ordinaryResult).toMatchObject({
			kind: 'person-failure',
			failure: { category: 'unexpected-status' },
		});

		const apiVersion = adapter([
			response(
				{ message: 'The API version is no longer supported.' },
				{ status: 400 },
			),
		]);
		const apiVersionResult =
			await apiVersion.adapter.retrieveEvents(eventsRequest());
		expect(apiVersionResult).toMatchObject({
			kind: 'provider-failure',
			failure: { category: 'api-version' },
		});

		const retiredVersion = adapter([
			response(
				{ message: 'The requested API version has been retired.' },
				{ status: 410 },
			),
		]);
		const retiredVersionResult =
			await retiredVersion.adapter.retrieveEvents(eventsRequest());
		expect(retiredVersionResult).toMatchObject({
			kind: 'provider-failure',
			failure: { category: 'api-version' },
		});

		const unrelatedGone = adapter([response({}, { status: 410 })]);
		const unrelatedGoneResult =
			await unrelatedGone.adapter.retrieveEvents(eventsRequest());
		expect(unrelatedGoneResult).toMatchObject({
			kind: 'person-failure',
			failure: { category: 'unexpected-status' },
		});

		for (const [status, message] of [
			[400, 'Schema version not supported.'],
			[410, 'Repository version is unsupported.'],
			[400, 'Client version is unsupported.'],
			[
				400,
				'The API version is supported, but this endpoint is not supported.',
			],
			[
				400,
				'The API version information is valid; this feature is unsupported.',
			],
		] as const) {
			const unrelatedVersion = adapter([
				response({ message }, { status }),
			]);
			const unrelatedVersionResult =
				await unrelatedVersion.adapter.retrieveEvents(eventsRequest());
			expect(unrelatedVersionResult).toMatchObject({
				kind: 'person-failure',
				failure: { category: 'unexpected-status' },
			});
		}
	});

	it('classifies invalid JSON as provider data, not transport retry', async () => {
		const invalidJson = response(undefined, {});
		const { adapter: github, requests } = adapter([invalidJson]);
		const result = await github.retrieveEvents(eventsRequest());

		expect(result).toMatchObject({
			kind: 'person-failure',
			failure: { category: 'malformed-provider-data' },
		});
		expect(requests).toHaveLength(1);
	});
});
