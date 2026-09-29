import { describe, expect, it, vi } from 'vitest';
import { FollowManagementApplication } from '../src/application/follow-management';
import { SyncAllApplication } from '../src/application/sync-all';
import { SyncOneApplication } from '../src/application/sync-one';
import { createApplicationMutationGuard } from '../src/application/mutation-guard';
import type {
	DevRadarSettingsV2,
	FollowedPersonV1,
} from '../src/domain/settings';
import { ACTIVITY_FAMILIES } from '../src/domain/activity';
import { validatePersistedSettingsV2 } from '../src/domain/settings';
import type {
	SettingsRuntimeState,
	SettingsSaveResult,
} from '../src/application/settings';

function person(username: string, githubAccountId: string): FollowedPersonV1 {
	return {
		username,
		githubAccountId,
		notePath: `People/${username}.md`,
		trackingStart: { mode: 'from-date', at: '2026-08-01T00:00:00.000Z' },
		syncState: {
			lastAttemptAt: '2026-08-20T10:00:00.000Z',
			lastSuccessfulSyncAt: '2026-08-20T10:01:00.000Z',
			seenEvents: [{ id: '100', createdAt: '2026-08-19T00:00:00Z' }],
			github: { pollNotBefore: '2026-08-21T00:00:00.000Z' },
		},
	};
}

function settings(): DevRadarSettingsV2 {
	return {
		schemaVersion: 2,
		followedPeople: [person('octocat', '42'), person('hubot', '7')],
		enabledActivityFamilies: [...ACTIVITY_FAMILIES],
		githubRequestPolicy: { rateLimitNotBefore: '2026-08-25T00:00:00.000Z' },
	};
}

function harness(
	initial = settings(),
	options: {
		confirm?: (message: string) => boolean;
		save?: (candidate: DevRadarSettingsV2) => Promise<SettingsSaveResult>;
		guard?: ReturnType<typeof createApplicationMutationGuard>;
	} = {},
) {
	let state: SettingsRuntimeState = { kind: 'ready', settings: initial };
	const saved: DevRadarSettingsV2[] = [];
	const save = vi.fn(async (candidate: DevRadarSettingsV2) => {
		saved.push(candidate);
		const result = options.save
			? await options.save(candidate)
			: ({ kind: 'saved', settings: candidate } as const);
		state =
			result.kind === 'saved'
				? { kind: 'ready', settings: result.settings }
				: { kind: 'recovery', diagnostic: { kind: 'write-failure' } };
		return result;
	});
	const confirm = vi.fn(options.confirm ?? (() => true));
	const mutationGuard = options.guard ?? createApplicationMutationGuard();
	const app = new FollowManagementApplication({
		settings: {
			getSettingsState: () => state,
			saveCandidateWithinMutation: save,
		},
		mutationGuard,
		confirmUnfollow: confirm,
	});
	return {
		app,
		confirm,
		save,
		saved,
		getState: () => state,
		setState: (next: SettingsRuntimeState) => {
			state = next;
		},
	};
}

describe('FollowManagementApplication.unfollow', () => {
	it('confirms the safety contract and removes only the selected association', async () => {
		const initial = settings();
		const view = harness(initial);

		await expect(view.app.unfollow('42')).resolves.toEqual({
			kind: 'unfollowed',
			username: 'octocat',
		});

		expect(view.confirm).toHaveBeenCalledTimes(1);
		expect(view.confirm.mock.calls[0]?.[0]).toContain('octocat');
		for (const phrase of [
			'note',
			'DevRadar-managed section',
			'recorded activity',
			'user-authored content',
		])
			expect(view.confirm.mock.calls[0]?.[0]).toContain(phrase);
		expect(view.save).toHaveBeenCalledTimes(1);
		expect(view.saved[0]?.followedPeople).toEqual([
			initial.followedPeople[1],
		]);
		expect(view.saved[0]?.githubRequestPolicy).toEqual(
			initial.githubRequestPolicy,
		);
		expect(view.saved[0]?.enabledActivityFamilies).toEqual(
			initial.enabledActivityFamilies,
		);
		expect(view.saved[0]?.followedPeople[0]).toEqual(
			initial.followedPeople[1],
		);
	});

	it('cancels without saving', async () => {
		const view = harness(settings(), { confirm: () => false });

		await expect(view.app.unfollow('42')).resolves.toEqual({
			kind: 'cancelled',
		});
		expect(view.save).not.toHaveBeenCalled();
	});

	it('reports persistence failure and leaves settings in recovery', async () => {
		const view = harness(settings(), {
			save: async () => ({ kind: 'write-failure' }),
		});

		await expect(view.app.unfollow('42')).resolves.toEqual({
			kind: 'failed',
			reason: 'persistence',
		});
		expect(view.getState()).toEqual({
			kind: 'recovery',
			diagnostic: { kind: 'write-failure' },
		});
	});

	it('leaves Sync One and Sync All with no work for an unfollowed account', async () => {
		const view = harness({
			...settings(),
			followedPeople: [person('octocat', '42')],
		});
		await expect(view.app.unfollow('42')).resolves.toMatchObject({
			kind: 'unfollowed',
		});
		const retrieveEvents = vi.fn(async () => ({
			kind: 'success' as const,
			requestAttempted: true as const,
			data: { activities: [] },
			policy: {},
		}));
		const mutationGuard = createApplicationMutationGuard();
		const syncOne = new SyncOneApplication({
			settings: {
				getSettingsState: view.getState,
				saveCandidateWithinMutation: view.save,
			},
			github: { retrieveEvents },
			notes: {} as never,
			now: () => '2026-09-29T00:00:00.000Z',
			isSupportedPlatform: () => true,
			mutationGuard,
		});
		const syncAllExecutor = {
			execute: vi.fn(async () => ({
				result: { kind: 'unchanged' as const },
				safeToContinue: true,
				providerWideStop: false as const,
			})),
		};
		const syncAll = new SyncAllApplication({
			settings: { getSettingsState: view.getState },
			executor: syncAllExecutor,
			mutationGuard,
			now: () => '2026-09-29T00:00:00.000Z',
			isSupportedPlatform: () => true,
		});

		await expect(
			syncOne.syncOne({ githubAccountId: '42' }),
		).resolves.toEqual({ kind: 'failed', reason: 'invalid-selection' });
		await expect(syncAll.syncAll()).resolves.toEqual({ kind: 'empty' });
		expect(retrieveEvents).not.toHaveBeenCalled();
		expect(syncAllExecutor.execute).not.toHaveBeenCalled();
	});

	it('preserves a global request boundary that still blocks another followed person', async () => {
		const boundary = '2026-08-30T00:00:00.000Z';
		const initial = {
			...settings(),
			githubRequestPolicy: { rateLimitNotBefore: boundary },
		};
		const view = harness(initial);
		await expect(view.app.unfollow('42')).resolves.toMatchObject({
			kind: 'unfollowed',
		});
		const current = view.getState();
		if (current.kind !== 'ready')
			throw new Error('expected ready settings');
		const validation = validatePersistedSettingsV2(
			current.settings,
			'2026-08-28T00:00:00.000Z',
		);
		if (!validation.ok) throw new Error(JSON.stringify(validation.error));
		const retrieveEvents = vi.fn(
			async (input: {
				globalPolicy?: { rateLimitNotBefore?: string };
			}) => ({
				kind: 'no-request' as const,
				requestAttempted: false as const,
				notBefore: input.globalPolicy?.rateLimitNotBefore,
				policy: {},
			}),
		);
		const syncOne = new SyncOneApplication({
			settings: {
				getSettingsState: view.getState,
				saveCandidateWithinMutation: view.save,
			},
			github: { retrieveEvents },
			notes: {} as never,
			now: () => '2026-08-28T00:00:00.000Z',
			isSupportedPlatform: () => true,
			mutationGuard: createApplicationMutationGuard(),
		});

		await expect(
			syncOne.syncOne({ githubAccountId: '7' }),
		).resolves.toEqual({ kind: 'skipped', reason: 'provider-policy' });
		expect(retrieveEvents).not.toHaveBeenCalled();
		expect(view.getState()).toMatchObject({
			kind: 'ready',
			settings: {
				githubRequestPolicy: { rateLimitNotBefore: boundary },
			},
		});
	});

	it('waits behind the shared mutation guard and rechecks the current account', async () => {
		const guard = createApplicationMutationGuard();
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const view = harness(settings(), { guard });
		const occupyingMutation = guard.run(async () => {
			entered();
			await blocked;
		});
		await started;
		const result = view.app.unfollow('42');
		await Promise.resolve();
		await Promise.resolve();
		expect(view.save).not.toHaveBeenCalled();
		release();
		await occupyingMutation;
		await expect(result).resolves.toEqual({
			kind: 'unfollowed',
			username: 'octocat',
		});
		expect(view.save).toHaveBeenCalledTimes(1);
	});

	it('rejects an account that is no longer followed after waiting for the guard', async () => {
		const guard = createApplicationMutationGuard();
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const view = harness(settings(), { guard });
		const occupyingMutation = guard.run(async () => {
			entered();
			await blocked;
		});
		await started;
		const result = view.app.unfollow('42');
		await Promise.resolve();
		view.setState({
			kind: 'ready',
			settings: { ...settings(), followedPeople: [person('hubot', '7')] },
		});
		release();
		await occupyingMutation;
		await expect(result).resolves.toEqual({
			kind: 'failed',
			reason: 'not-followed',
		});
		expect(view.save).not.toHaveBeenCalled();
	});
});
