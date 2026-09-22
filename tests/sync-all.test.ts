import { describe, expect, it, vi } from 'vitest';
import type { ApplicationMutationGuard } from '../src/application/mutation-guard';
import { SyncAllApplication } from '../src/application/sync-all';
import type { SettingsRuntimeState } from '../src/application/settings';
import type {
	SyncPersonExecution,
	SyncPersonExecutor,
} from '../src/application/sync-person';
import { ACTIVITY_FAMILIES } from '../src/domain/activity';
import {
	createEmptyPersonSyncState,
	type DevRadarSettingsV2,
	type FollowedPersonV1,
} from '../src/domain/settings';
import type { SyncOneResult } from '../src/application/sync-one';

const person = (
	username: string,
	githubAccountId: string,
	patch: Partial<FollowedPersonV1> = {},
): FollowedPersonV1 => ({
	username,
	githubAccountId,
	notePath: `People/${username}.md`,
	trackingStart: { mode: 'available-recent' },
	syncState: createEmptyPersonSyncState(),
	...patch,
});

const settings = (people: readonly FollowedPersonV1[]): DevRadarSettingsV2 => ({
	schemaVersion: 2,
	followedPeople: [...people],
	enabledActivityFamilies: [...ACTIVITY_FAMILIES],
});

const ready = (value: DevRadarSettingsV2): SettingsRuntimeState => ({
	kind: 'ready',
	settings: value,
});

describe('Sync All application', () => {
	it('stops before person work when settings are not ready', async () => {
		const executor: Pick<SyncPersonExecutor, 'execute'> = {
			execute: vi.fn(),
		};
		const application = new SyncAllApplication({
			settings: {
				getSettingsState: () => ({
					kind: 'recovery',
					diagnostic: { kind: 'read-failure' },
				}),
			},
			executor,
			mutationGuard: { run: async (operation) => operation() },
			now: () => '2026-09-23T12:00:00.000Z',
			isSupportedPlatform: () => true,
		});

		expect(await application.syncAll()).toEqual({
			kind: 'failed',
			reason: 'settings-not-ready',
		});
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it('rejects invalid V2 settings before person work', async () => {
		const invalid = {
			...settings([person('octocat', '20')]),
			schemaVersion: 1,
		} as unknown as DevRadarSettingsV2;
		const executor: Pick<SyncPersonExecutor, 'execute'> = {
			execute: vi.fn(),
		};
		const application = new SyncAllApplication({
			settings: { getSettingsState: () => ready(invalid) },
			executor,
			mutationGuard: { run: async (operation) => operation() },
			now: () => '2026-09-23T12:00:00.000Z',
			isSupportedPlatform: () => true,
		});

		expect(await application.syncAll()).toEqual({
			kind: 'failed',
			reason: 'configuration',
		});
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it('fails closed before reading settings on an unsupported platform', async () => {
		const getSettingsState = vi.fn(() =>
			ready(settings([person('octocat', '20')])),
		);
		const executor: Pick<SyncPersonExecutor, 'execute'> = {
			execute: vi.fn(),
		};
		const application = new SyncAllApplication({
			settings: { getSettingsState },
			executor,
			mutationGuard: { run: async (operation) => operation() },
			now: () => '2026-09-23T12:00:00.000Z',
			isSupportedPlatform: () => false,
		});

		expect(await application.syncAll()).toEqual({
			kind: 'failed',
			reason: 'unsupported-platform',
		});
		expect(getSettingsState).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it('returns empty without invoking the executor when nobody is followed', async () => {
		const executor: Pick<SyncPersonExecutor, 'execute'> = {
			execute: vi.fn(),
		};
		const application = new SyncAllApplication({
			settings: { getSettingsState: () => ready(settings([])) },
			executor,
			mutationGuard: { run: async (operation) => operation() },
			now: () => '2026-09-23T12:00:00.000Z',
			isSupportedPlatform: () => true,
		});

		expect(await application.syncAll()).toEqual({ kind: 'empty' });
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it('continues after person polling skips and persisted ordinary failures', async () => {
		const followed = [
			person('zebra', '20'),
			person('octocat', '10'),
			person('owl', '30'),
		];
		const executor: Pick<SyncPersonExecutor, 'execute'> = {
			execute: vi
				.fn<SyncPersonExecutor['execute']>()
				.mockResolvedValueOnce({
					result: { kind: 'skipped', reason: 'provider-policy' },
					safeToContinue: true,
					providerWideStop: false,
				})
				.mockResolvedValueOnce({
					result: { kind: 'failed', reason: 'provider' },
					safeToContinue: true,
					providerWideStop: false,
				})
				.mockResolvedValueOnce({
					result: { kind: 'unchanged' },
					safeToContinue: true,
					providerWideStop: false,
				}),
		};
		const application = new SyncAllApplication({
			settings: { getSettingsState: () => ready(settings(followed)) },
			executor,
			mutationGuard: { run: async (operation) => operation() },
			now: () => '2026-09-23T12:00:00.000Z',
			isSupportedPlatform: () => true,
		});

		const result = await application.syncAll();

		expect(executor.execute).toHaveBeenCalledTimes(3);
		expect(result).toEqual({
			kind: 'completed',
			outcomes: [
				{
					username: 'zebra',
					result: { kind: 'skipped', reason: 'provider-policy' },
				},
				{
					username: 'octocat',
					result: { kind: 'failed', reason: 'provider' },
				},
				{ username: 'owl', result: { kind: 'unchanged' } },
			],
		});
	});

	it('stops after a newly persisted global policy boundary and counts remaining people as skipped', async () => {
		const followed = [
			person('zebra', '20'),
			person('octocat', '10'),
			person('owl', '30'),
		];
		let runtime: SettingsRuntimeState = ready(settings(followed));
		const executor: Pick<SyncPersonExecutor, 'execute'> = {
			execute: vi.fn<SyncPersonExecutor['execute']>(async () => {
				const current = runtime;
				if (current.kind !== 'ready')
					throw new Error('settings unavailable');
				runtime = ready({
					...current.settings,
					githubRequestPolicy: {
						rateLimitNotBefore: '2026-09-23T12:30:00.000Z',
					},
				});
				return {
					result: { kind: 'failed', reason: 'provider' },
					safeToContinue: true,
					providerWideStop: false,
				};
			}),
		};
		const application = new SyncAllApplication({
			settings: { getSettingsState: () => runtime },
			executor,
			mutationGuard: { run: async (operation) => operation() },
			now: () => '2026-09-23T12:00:00.000Z',
			isSupportedPlatform: () => true,
		});

		const result = await application.syncAll();

		expect(executor.execute).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			kind: 'completed',
			outcomes: [
				{
					username: 'zebra',
					result: { kind: 'failed', reason: 'provider' },
				},
			],
			stop: { kind: 'provider-policy', skipped: 2 },
		});
	});

	it('stops remaining people after a provider-wide failure without a global timestamp', async () => {
		const followed = [
			person('zebra', '20'),
			person('octocat', '10'),
			person('owl', '30'),
		];
		const executor: Pick<SyncPersonExecutor, 'execute'> = {
			execute: vi.fn(async (): Promise<SyncPersonExecution> => ({
				result: { kind: 'failed', reason: 'provider' },
				safeToContinue: true,
				providerWideStop: true,
			})),
		};
		const application = new SyncAllApplication({
			settings: { getSettingsState: () => ready(settings(followed)) },
			executor,
			mutationGuard: { run: async (operation) => operation() },
			now: () => '2026-09-23T12:00:00.000Z',
			isSupportedPlatform: () => true,
		});

		const result = await application.syncAll();

		expect(executor.execute).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			kind: 'completed',
			outcomes: [
				{
					username: 'zebra',
					result: { kind: 'failed', reason: 'provider' },
				},
			],
			stop: { kind: 'provider-policy', skipped: 2 },
		});
	});

	it('does not stop for a global policy boundary that has expired by the reread', async () => {
		const followed = [person('zebra', '20'), person('octocat', '10')];
		let runtime: SettingsRuntimeState = ready(settings(followed));
		let calls = 0;
		const executor: Pick<SyncPersonExecutor, 'execute'> = {
			execute: vi.fn<SyncPersonExecutor['execute']>(async () => {
				calls += 1;
				if (calls === 1) {
					const current = runtime;
					if (current.kind !== 'ready')
						throw new Error('settings unavailable');
					runtime = ready({
						...current.settings,
						githubRequestPolicy: {
							rateLimitNotBefore: '2026-09-23T12:30:00.000Z',
						},
					});
					return {
						result: { kind: 'failed', reason: 'provider' },
						safeToContinue: true,
						providerWideStop: false,
					};
				}
				return {
					result: { kind: 'unchanged' },
					safeToContinue: true,
					providerWideStop: false,
				};
			}),
		};
		const instants = [
			'2026-09-23T12:00:00.000Z',
			'2026-09-23T12:01:00.000Z',
			'2026-09-23T12:31:00.000Z',
			'2026-09-23T12:32:00.000Z',
			'2026-09-23T12:33:00.000Z',
		];
		let instantIndex = 0;
		const application = new SyncAllApplication({
			settings: { getSettingsState: () => runtime },
			executor,
			mutationGuard: { run: async (operation) => operation() },
			now: () => instants[instantIndex++] ?? '2026-09-23T12:33:00.000Z',
			isSupportedPlatform: () => true,
		});

		const result = await application.syncAll();

		expect(executor.execute).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({
			kind: 'completed',
			outcomes: [
				{
					username: 'zebra',
					result: { kind: 'failed', reason: 'provider' },
				},
				{ username: 'octocat', result: { kind: 'unchanged' } },
			],
		});
	});

	it('stops after settings leave ready state and counts remaining people as unattempted', async () => {
		const followed = [person('zebra', '20'), person('octocat', '10')];
		let runtime: SettingsRuntimeState = ready(settings(followed));
		const executor: Pick<SyncPersonExecutor, 'execute'> = {
			execute: vi.fn<SyncPersonExecutor['execute']>(async () => {
				runtime = {
					kind: 'recovery',
					diagnostic: { kind: 'read-failure' },
				};
				return {
					result: { kind: 'updated' },
					safeToContinue: true,
					providerWideStop: false,
				};
			}),
		};
		const application = new SyncAllApplication({
			settings: { getSettingsState: () => runtime },
			executor,
			mutationGuard: { run: async (operation) => operation() },
			now: () => '2026-09-23T12:00:00.000Z',
			isSupportedPlatform: () => true,
		});

		const result = await application.syncAll();

		expect(executor.execute).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			kind: 'completed',
			outcomes: [{ username: 'zebra', result: { kind: 'updated' } }],
			stop: { kind: 'settings-recovery', unattempted: 1 },
		});
	});

	it('keeps completed outcomes when a settings reread throws before the next person', async () => {
		const followed = [person('zebra', '20'), person('octocat', '10')];
		let reads = 0;
		const executor: Pick<SyncPersonExecutor, 'execute'> = {
			execute: vi.fn(async (): Promise<SyncPersonExecution> => ({
				result: { kind: 'updated' },
				safeToContinue: true,
				providerWideStop: false,
			})),
		};
		const application = new SyncAllApplication({
			settings: {
				getSettingsState: () => {
					reads += 1;
					if (reads === 4) throw new Error('settings read failed');
					return ready(settings(followed));
				},
			},
			executor,
			mutationGuard: { run: async (operation) => operation() },
			now: () => '2026-09-23T12:00:00.000Z',
			isSupportedPlatform: () => true,
		});

		const result = await application.syncAll();

		expect(executor.execute).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			kind: 'completed',
			outcomes: [{ username: 'zebra', result: { kind: 'updated' } }],
			stop: { kind: 'run-failure', reason: 'internal', unattempted: 1 },
		});
	});

	it('stops after an executor failure without a completed persistence boundary', async () => {
		const followed = [person('zebra', '20'), person('octocat', '10')];
		const getSettingsState = vi.fn(() => ready(settings(followed)));
		const executor: Pick<SyncPersonExecutor, 'execute'> = {
			execute: vi.fn(async (): Promise<SyncPersonExecution> => ({
				result: { kind: 'failed', reason: 'internal' },
				safeToContinue: false,
				providerWideStop: false,
			})),
		};
		const application = new SyncAllApplication({
			settings: { getSettingsState },
			executor,
			mutationGuard: { run: async (operation) => operation() },
			now: () => '2026-09-23T12:00:00.000Z',
			isSupportedPlatform: () => true,
		});

		const result = await application.syncAll();

		expect(executor.execute).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			kind: 'completed',
			outcomes: [
				{
					username: 'zebra',
					result: { kind: 'failed', reason: 'internal' },
				},
			],
			stop: { kind: 'run-failure', reason: 'internal', unattempted: 1 },
		});
	});

	it('stops on failed persistence and reports only the remaining people as unattempted', async () => {
		const followed = [
			person('zebra', '20'),
			person('octocat', '10'),
			person('owl', '30'),
		];
		const executor: Pick<SyncPersonExecutor, 'execute'> = {
			execute: vi
				.fn<SyncPersonExecutor['execute']>()
				.mockResolvedValueOnce({
					result: { kind: 'updated' },
					safeToContinue: true,
					providerWideStop: false,
				})
				.mockResolvedValueOnce({
					result: { kind: 'failed', reason: 'persistence' },
					safeToContinue: false,
					providerWideStop: false,
				}),
		};
		const application = new SyncAllApplication({
			settings: { getSettingsState: () => ready(settings(followed)) },
			executor,
			mutationGuard: {
				run: async <T>(operation: () => Promise<T>) => operation(),
			},
			now: () => '2026-09-23T12:00:00.000Z',
			isSupportedPlatform: () => true,
		});

		const result = await application.syncAll();

		expect(executor.execute).toHaveBeenCalledTimes(2);
		expect(result).toEqual({
			kind: 'completed',
			outcomes: [
				{ username: 'zebra', result: { kind: 'updated' } },
				{
					username: 'octocat',
					result: { kind: 'failed', reason: 'persistence' },
				},
			],
			stop: { kind: 'settings-recovery', unattempted: 1 },
		});
	});

	it('holds one guard and executes people sequentially in persisted order', async () => {
		const followed = [person('zebra', '20'), person('octocat', '10')];
		let runtime: SettingsRuntimeState = ready(settings(followed));
		const getSettingsState = vi.fn(() => runtime);
		const events: string[] = [];
		const results: Record<string, SyncOneResult> = {
			'20': { kind: 'updated' },
			'10': { kind: 'unchanged' },
		};
		const executor: Pick<SyncPersonExecutor, 'execute'> = {
			execute: vi.fn<SyncPersonExecutor['execute']>(
				async ({ githubAccountId }) => {
					events.push(`start:${githubAccountId}`);
					if (githubAccountId === '20') {
						const current = runtime;
						if (current.kind !== 'ready')
							throw new Error('settings not ready');
						runtime = ready({
							...current.settings,
							followedPeople: current.settings.followedPeople.map(
								(item) =>
									item.githubAccountId === '20'
										? {
												...item,
												syncState: {
													...item.syncState,
													lastAttemptAt:
														'2026-09-23T12:00:00.000Z',
												},
											}
										: item,
							),
						});
					}
					await Promise.resolve();
					const current = runtime;
					if (current.kind !== 'ready')
						throw new Error('settings not ready');
					events.push(
						`end:${githubAccountId}:${current.settings.followedPeople[0]?.syncState.lastAttemptAt ?? 'initial'}`,
					);
					return {
						result: results[githubAccountId] ?? {
							kind: 'failed',
							reason: 'internal',
						},
						safeToContinue: true,
						providerWideStop: false,
					};
				},
			),
		};
		let guardCalls = 0;
		const mutationGuard: ApplicationMutationGuard = {
			run: async <T>(operation: () => Promise<T>) => {
				guardCalls += 1;
				return operation();
			},
		};
		const application = new SyncAllApplication({
			settings: { getSettingsState },
			executor,
			mutationGuard,
			now: () => '2026-09-23T12:00:00.000Z',
			isSupportedPlatform: () => true,
		});

		const result = await application.syncAll();

		expect(guardCalls).toBe(1);
		expect(executor.execute).toHaveBeenNthCalledWith(1, {
			githubAccountId: '20',
		});
		expect(executor.execute).toHaveBeenNthCalledWith(2, {
			githubAccountId: '10',
		});
		expect(events).toEqual([
			'start:20',
			'end:20:2026-09-23T12:00:00.000Z',
			'start:10',
			'end:10:2026-09-23T12:00:00.000Z',
		]);
		expect(getSettingsState).toHaveBeenCalled();
		expect(result).toEqual({
			kind: 'completed',
			outcomes: [
				{ username: 'zebra', result: { kind: 'updated' } },
				{ username: 'octocat', result: { kind: 'unchanged' } },
			],
		});
	});
});
