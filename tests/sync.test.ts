import { describe, expect, it } from 'vitest';
import {
	createIssueActivity,
	createPullRequestActivity,
	type Activity,
} from '../src/domain/activity';
import {
	parseCanonicalActivityEntries,
	renderActivityEntry,
	type RetainedActivityEntry,
} from '../src/domain/person-note';
import {
	createEmptyPersonSyncState,
	type PersonSyncState,
} from '../src/domain/settings';
import {
	applyFailedSyncTransition,
	applySuccessfulSyncTransition,
	confirmAccounting,
	reconcileActivities,
} from '../src/domain/sync';
import { validateCanonicalPluginTimestamp } from '../src/domain/settings';

const ok = <T>(result: { ok: boolean; value?: T }): T => {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error('expected successful result');
	return result.value as T;
};

const issue = (
	providerEventId: string,
	timestamp: string,
	title = providerEventId,
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

const detailPullRequest = (
	providerEventId: string,
	title: string,
): Activity => {
	const result = createPullRequestActivity({
		providerEventId,
		timestamp: '2026-08-18T03:00:00Z',
		repository: 'octocat/hello-world',
		number: '5',
		title,
		action: 'closed',
	});
	if (!result.ok) throw new Error(result.error.message);
	return { ...result.value, titleSource: 'detail' as const };
};

const retained = (...activities: Activity[]): RetainedActivityEntry[] =>
	parseCanonicalActivityEntries(
		[
			'## DevRadar activity',
			'',
			...activities.map(renderActivityEntry),
		].join('\n'),
	) as RetainedActivityEntry[];

const pluginTimestamp = (value: string) => {
	const result = validateCanonicalPluginTimestamp(value);
	return ok(result);
};

const planInput = (
	activities: readonly Activity[],
	state: PersonSyncState = createEmptyPersonSyncState(),
	retainedEntries: readonly RetainedActivityEntry[] = [],
) => ({ activities, state, retainedEntries });

describe('synchronization reconciliation', () => {
	it('reconciles one retained occurrence per unseen provider event', () => {
		const first = issue('1', '2026-08-18T03:00:00Z', 'same');
		const second = issue('2', '2026-08-18T03:00:00Z', 'same');
		const result = ok(
			reconcileActivities(
				planInput([first, second], undefined, retained(first)),
			),
		);

		expect(
			result.reconciledActivities.map((item) => item.providerEventId),
		).toEqual(['1']);
		expect(
			result.newActivities.map((item) => item.providerEventId),
		).toEqual(['2']);
		expect(result.finalEntries).toHaveLength(2);
	});

	it('fails when the same provider ID has conflicting canonical activities', () => {
		const result = reconcileActivities(
			planInput([
				issue('1', '2026-08-18T03:00:00Z', 'first'),
				issue('1', '2026-08-18T03:00:00Z', 'second'),
			]),
		);

		expect(result).toMatchObject({
			ok: false,
			error: {
				kind: 'conflicting-provider-activity',
				providerEventId: '1',
			},
		});
	});

	it('collapses equivalent repeated provider IDs', () => {
		const result = ok(
			reconcileActivities(
				planInput([
					issue('1', '2026-08-18T03:00:00Z'),
					issue('1', '2026-08-18T03:00:00Z'),
				]),
			),
		);

		expect(
			result.newActivities.map((item) => item.providerEventId),
		).toEqual(['1']);
	});

	it('reduces duplicate PR provenance consistently before reconciliation', () => {
		const eventActivity = detailPullRequest('1', 'Title B');
		const eventSourced = { ...eventActivity, titleSource: undefined };
		const retainedActivity = detailPullRequest('9', 'Title A');
		const plans = [
			[eventSourced, eventActivity],
			[eventActivity, eventSourced],
		].map((activities) =>
			ok(
				reconcileActivities(
					planInput(
						activities,
						undefined,
						retained(retainedActivity),
					),
				),
			),
		);

		expect(plans[0]).toEqual(plans[1]);
		expect(plans[0]?.newActivities).toHaveLength(1);
	});

	it('reconciles mutable detail titles using stable Pull Request identity', () => {
		const retainedActivity = detailPullRequest('1', 'Title A');
		const currentActivity = detailPullRequest('1', 'Title B');
		const result = ok(
			reconcileActivities(
				planInput(
					[currentActivity],
					undefined,
					retained(retainedActivity),
				),
			),
		);

		expect(result.reconciledActivities).toEqual([currentActivity]);
		expect(result.newActivities).toEqual([]);
	});

	it('fails closed when mutable detail identity is ambiguous', () => {
		const first = detailPullRequest('1', 'Title A');
		const second = detailPullRequest('2', 'Title B');
		const current = detailPullRequest('3', 'Title C');
		const result = reconcileActivities(
			planInput([current], undefined, retained(first, second)),
		);

		expect(result).toMatchObject({
			ok: false,
			error: {
				kind: 'ambiguous-reconciliation',
				providerEventId: '3',
			},
		});
	});

	it('fails when a prior seen event timestamp conflicts with current activity', () => {
		const state: PersonSyncState = {
			seenEvents: [{ id: '1', createdAt: '2026-08-18T02:00:00Z' }],
			github: {},
		};
		const result = reconcileActivities(
			planInput([issue('1', '2026-08-18T03:00:00Z')], state),
		);

		expect(result).toMatchObject({
			ok: false,
			error: {
				kind: 'seen-event-timestamp-mismatch',
				providerEventId: '1',
			},
		});
	});

	it('does not restore a deleted prior-seen entry', () => {
		const state: PersonSyncState = {
			seenEvents: [{ id: '1', createdAt: '2026-08-18T03:00:00Z' }],
			github: {},
		};
		const result = ok(
			reconcileActivities(
				planInput([issue('1', '2026-08-18T03:00:00Z')], state),
			),
		);

		expect(result.newActivities).toEqual([]);
		expect(result.reconciledActivities).toEqual([]);
		expect(result.finalEntries).toEqual([]);
	});

	it('retains canonical history when the provider feed is empty', () => {
		const old = issue('1', '2026-08-10T03:00:00Z', 'old');
		const result = ok(
			reconcileActivities(planInput([], undefined, retained(old))),
		);

		expect(result.finalEntries).toHaveLength(1);
		expect(result.finalEntries[0]).toMatchObject({ kind: 'retained' });
	});

	it('does not mutate reconciliation inputs', () => {
		const activity = issue('1', '2026-08-18T03:00:00Z');
		const input = planInput(
			[activity],
			{
				seenEvents: [],
				github: {},
			},
			retained(activity),
		);
		const originalInput = structuredClone(input);

		reconcileActivities(input);

		expect(input).toEqual(originalInput);
	});

	it('merges retained and new entries in the settled timestamp order', () => {
		const retainedFirst = issue(
			'10',
			'2026-08-18T03:00:00Z',
			'retained-first',
		);
		const retainedSecond = issue(
			'11',
			'2026-08-18T03:00:00Z',
			'retained-second',
		);
		const retainedOlder = issue(
			'12',
			'2026-08-18T02:00:00Z',
			'retained-old',
		);
		const newNewer = issue('2', '2026-08-18T04:00:00Z', 'new-newer');
		const newEqual = issue('1', '2026-08-18T03:00:00Z', 'new-equal');
		const newOlder = issue('3', '2026-08-18T02:00:00Z', 'new-older');
		const result = ok(
			reconcileActivities(
				planInput(
					[newNewer, newEqual, newOlder],
					undefined,
					retained(retainedFirst, retainedSecond, retainedOlder),
				),
			),
		);

		expect(
			result.finalEntries.map((entry) =>
				entry.kind === 'retained'
					? entry.entry.markdown
					: renderActivityEntry(entry.activity),
			),
		).toEqual([
			renderActivityEntry(newNewer),
			renderActivityEntry(retainedFirst),
			renderActivityEntry(retainedSecond),
			renderActivityEntry(newEqual),
			renderActivityEntry(retainedOlder),
			renderActivityEntry(newOlder),
		]);
	});
});

describe('current-note accounting confirmation', () => {
	it('requires fresh current entries and consumes duplicate occurrences safely', () => {
		const first = issue('1', '2026-08-18T03:00:00Z', 'same');
		const second = issue('2', '2026-08-18T03:00:00Z', 'same');
		const initial = retained(first);
		const candidates = [first, second];

		expect(confirmAccounting(initial, candidates)).toMatchObject({
			ok: false,
			error: { kind: 'unconfirmed-accounting', providerEventId: '2' },
		});
		expect(
			confirmAccounting(retained(first, second), candidates),
		).toMatchObject({
			ok: true,
		});
	});

	it('confirms newly rendered activity only from the current post-write snapshot', () => {
		const activity = issue('1', '2026-08-18T03:00:00Z');
		const plan = ok(reconcileActivities(planInput([activity])));

		expect(confirmAccounting([], plan.accountingCandidates)).toMatchObject({
			ok: false,
		});
		expect(
			confirmAccounting(retained(activity), plan.accountingCandidates),
		).toMatchObject({ ok: true });
	});
});

describe('per-person sync-state transitions', () => {
	it('derives seen-event timestamps and appends confirmed IDs deterministically', () => {
		const state: PersonSyncState = {
			seenEvents: [{ id: '9', createdAt: '2026-08-17T00:00:00Z' }],
			github: {},
		};
		const activities = [
			issue('2', '2026-08-18T02:00:00Z'),
			issue('1', '2026-08-18T03:00:00Z'),
			issue('9', '2026-08-17T00:00:00Z'),
		];
		const confirmation = ok(
			confirmAccounting(retained(...activities), activities),
		);
		const result = ok(
			applySuccessfulSyncTransition(state, confirmation, {
				completedAt: pluginTimestamp('2026-08-20T12:00:00.000Z'),
			}),
		);

		expect(result.seenEvents).toEqual([
			{ id: '9', createdAt: '2026-08-17T00:00:00Z' },
			{ id: '1', createdAt: '2026-08-18T03:00:00Z' },
			{ id: '2', createdAt: '2026-08-18T02:00:00Z' },
		]);
		expect(result.lastSuccessfulSyncAt).toBe('2026-08-20T12:00:00.000Z');
	});

	it('preserves omitted attempt metadata and updates explicitly supplied metadata', () => {
		const state: PersonSyncState = {
			lastAttemptAt: '2026-08-19T12:00:00.000Z',
			lastSuccessfulSyncAt: '2026-08-19T12:00:00.000Z',
			seenEvents: [],
			github: { pollNotBefore: '2026-08-21T00:00:00.000Z' },
		};
		const activity = issue('1', '2026-08-18T03:00:00Z');
		const confirmation = ok(
			confirmAccounting(retained(activity), [activity]),
		);
		const preserved = ok(
			applySuccessfulSyncTransition(state, confirmation, {
				completedAt: pluginTimestamp('2026-08-20T12:00:00.000Z'),
			}),
		);
		const updated = ok(
			applyFailedSyncTransition(state, {
				lastAttemptAt: pluginTimestamp('2026-08-20T13:00:00.000Z'),
				pollNotBefore: pluginTimestamp('2026-08-20T00:00:00.000Z'),
			}),
		);

		expect(preserved.lastAttemptAt).toBe(state.lastAttemptAt);
		expect(preserved.github.pollNotBefore).toBe(state.github.pollNotBefore);
		expect(updated.lastAttemptAt).toBe('2026-08-20T13:00:00.000Z');
		expect(updated.github.pollNotBefore).toBe(state.github.pollNotBefore);
		expect(updated.lastSuccessfulSyncAt).toBe(state.lastSuccessfulSyncAt);
	});

	it('treats an undefined attempt timestamp as omitted', () => {
		const state: PersonSyncState = {
			lastAttemptAt: '2026-08-19T12:00:00.000Z',
			lastSuccessfulSyncAt: '2026-08-19T12:30:00.000Z',
			seenEvents: [{ id: '1', createdAt: '2026-08-18T03:00:00Z' }],
			github: {},
		};
		const confirmation = ok(confirmAccounting([], []));
		const successful = ok(
			applySuccessfulSyncTransition(state, confirmation, {
				completedAt: pluginTimestamp('2026-08-20T12:00:00.000Z'),
				lastAttemptAt: undefined,
			}),
		);
		const failed = ok(
			applyFailedSyncTransition(state, { lastAttemptAt: undefined }),
		);

		expect(successful.lastAttemptAt).toBe(state.lastAttemptAt);
		expect(failed.lastAttemptAt).toBe(state.lastAttemptAt);
		expect(failed.seenEvents).toEqual(state.seenEvents);
	});

	it('treats an unchanged successful sync as successful', () => {
		const state = createEmptyPersonSyncState();
		const confirmation = ok(confirmAccounting([], []));
		const result = ok(
			applySuccessfulSyncTransition(state, confirmation, {
				completedAt: pluginTimestamp('2026-08-20T12:00:00.000Z'),
			}),
		);

		expect(result.lastSuccessfulSyncAt).toBe('2026-08-20T12:00:00.000Z');
		expect(result.seenEvents).toEqual([]);
	});

	it('does not mutate prior state or confirmation inputs', () => {
		const activity = issue('1', '2026-08-18T03:00:00Z');
		const state = createEmptyPersonSyncState();
		const confirmation = ok(
			confirmAccounting(retained(activity), [activity]),
		);
		const originalState = structuredClone(state);
		const originalConfirmation = structuredClone(confirmation);

		applySuccessfulSyncTransition(state, confirmation, {
			completedAt: pluginTimestamp('2026-08-20T12:00:00.000Z'),
		});

		expect(state).toEqual(originalState);
		expect(confirmation).toEqual(originalConfirmation);
	});
});
