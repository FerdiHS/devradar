import { describe, expect, it, vi } from 'vitest';
import { FollowManagementApplication } from '../src/application/follow-management';
import { SyncAllApplication } from '../src/application/sync-all';
import { SyncOneApplication } from '../src/application/sync-one';
import { createApplicationMutationGuard } from '../src/application/mutation-guard';
import type {
	DevRadarSettingsV2,
	FollowedPersonV1,
} from '../src/domain/settings';
import { ACTIVITY_FAMILIES, createIssueActivity } from '../src/domain/activity';
import { validatePersistedSettingsV2 } from '../src/domain/settings';
import type {
	SettingsRuntimeState,
	SettingsSaveResult,
} from '../src/application/settings';
import type {
	AssociationTransform,
	CurrentContentTransform,
	NotePersistence,
	NotePreparationResult,
	NoteProcessResult,
} from '../src/application/note-persistence';
import {
	renderActivityEntry,
	type PersonIdentity,
} from '../src/domain/person-note';

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
		notePreparation?: NotePreparationResult | 'throw';
		guard?: ReturnType<typeof createApplicationMutationGuard>;
		now?: () => string;
	} = {},
) {
	let state: SettingsRuntimeState = { kind: 'ready', settings: initial };
	let persisted = initial;
	const saved: DevRadarSettingsV2[] = [];
	const noteContents = new Map(
		initial.followedPeople.map((person) => [
			person.notePath,
			`existing note bytes for ${person.notePath}`,
		]),
	);
	const prepared: {
		path: string;
		identity: PersonIdentity;
		transform: AssociationTransform;
	}[] = [];
	const save = vi.fn(async (candidate: DevRadarSettingsV2) => {
		saved.push(candidate);
		const result = options.save
			? await options.save(candidate)
			: ({ kind: 'saved', settings: candidate } as const);
		if (result.kind === 'saved') persisted = result.settings;
		state =
			result.kind === 'saved'
				? { kind: 'ready', settings: result.settings }
				: { kind: 'recovery', diagnostic: { kind: 'write-failure' } };
		return result;
	});
	const notes: Pick<NotePersistence, 'prepareAssociation'> = {
		prepareAssociation: vi.fn<NotePersistence['prepareAssociation']>(
			async (path, identity, transform) => {
				prepared.push({ path, identity, transform });
				if (options.notePreparation === 'throw')
					throw new Error('note preparation failed');
				const result = options.notePreparation ?? { kind: 'reused' };
				if (result.kind === 'created')
					noteContents.set(path, `created managed note at ${path}`);
				else if (result.kind === 'initialized')
					noteContents.set(
						path,
						`${noteContents.get(path) ?? ''}\nmanaged section initialized`,
					);
				return result;
			},
		),
	};
	const confirm = vi.fn(options.confirm ?? (() => true));
	const mutationGuard = options.guard ?? createApplicationMutationGuard();
	const app = new FollowManagementApplication({
		settings: {
			getSettingsState: () => state,
			saveCandidateWithinMutation: save,
		},
		notes,
		mutationGuard,
		confirmUnfollow: confirm,
		now: options.now ?? (() => '2026-08-28T00:00:00.000Z'),
	});
	return {
		app,
		confirm,
		notes,
		noteContents,
		prepared,
		save,
		saved,
		getState: () => state,
		getPersisted: () => persisted,
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

describe('FollowManagementApplication.changeTrackingStart', () => {
	it('resolves Now after entering the mutation guard and stores the commit instant', async () => {
		let instant = '2026-08-28T00:00:00.000Z';
		const now = vi.fn(() => instant);
		const guard = {
			run: async <T>(operation: () => Promise<T>) => {
				instant = '2026-08-28T00:01:02.345Z';
				return operation();
			},
		};
		const view = harness(settings(), { guard, now });

		await expect(
			view.app.changeTrackingStart('42', { mode: 'now' }),
		).resolves.toEqual({
			kind: 'updated',
			username: 'octocat',
			trackingStart: {
				mode: 'from-now',
				at: '2026-08-28T00:01:02.345Z',
			},
		});
		expect(now).toHaveBeenCalledTimes(1);
		expect(view.saved[0]?.followedPeople[0]?.trackingStart).toEqual({
			mode: 'from-now',
			at: '2026-08-28T00:01:02.345Z',
		});
	});

	it('stores Available recent without a timestamp', async () => {
		const view = harness();

		await expect(
			view.app.changeTrackingStart('42', { mode: 'available-recent' }),
		).resolves.toEqual({
			kind: 'updated',
			username: 'octocat',
			trackingStart: { mode: 'available-recent' },
		});
		expect(view.saved[0]?.followedPeople[0]?.trackingStart).toEqual({
			mode: 'available-recent',
		});
	});

	it('accepts canonical past dates in either direction and preserves all other settings', async () => {
		for (const at of [
			'2026-08-02T12:34:56.789Z',
			'2026-07-31T23:59:59.999Z',
		]) {
			const initial = settings();
			const view = harness(initial);
			await expect(
				view.app.changeTrackingStart('42', { mode: 'from-date', at }),
			).resolves.toEqual({
				kind: 'updated',
				username: 'octocat',
				trackingStart: { mode: 'from-date', at },
			});
			const candidate = view.saved[0];
			const originalPerson = initial.followedPeople[0];
			if (!originalPerson) throw new Error('expected selected person');
			expect(candidate?.followedPeople[0]?.trackingStart).toEqual({
				mode: 'from-date',
				at,
			});
			expect(candidate?.followedPeople[0]).toEqual({
				...originalPerson,
				trackingStart: { mode: 'from-date', at },
			});
			expect(candidate?.followedPeople[0]?.syncState).toEqual(
				initial.followedPeople[0]?.syncState,
			);
			expect(candidate?.followedPeople[1]).toEqual(
				initial.followedPeople[1],
			);
			expect(candidate?.githubRequestPolicy).toEqual(
				initial.githubRequestPolicy,
			);
			expect(candidate?.enabledActivityFamilies).toEqual(
				initial.enabledActivityFamilies,
			);
		}
	});

	it('rejects noncanonical and future dates without saving', async () => {
		const view = harness();
		for (const draft of [
			{ mode: 'from-date', at: '2026-08-20T00:00:00Z' },
			{ mode: 'from-date', at: '2026-08-29T00:00:00.000Z' },
			{ mode: 'unknown' },
		]) {
			await expect(
				view.app.changeTrackingStart('42', draft as never),
			).resolves.toEqual({ kind: 'failed', reason: 'invalid-input' });
		}
		expect(view.save).not.toHaveBeenCalled();
	});

	it('reports persistence failure and enters settings recovery', async () => {
		const view = harness(settings(), {
			save: async () => ({ kind: 'write-failure' }),
		});

		await expect(
			view.app.changeTrackingStart('42', { mode: 'available-recent' }),
		).resolves.toEqual({ kind: 'failed', reason: 'persistence' });
		expect(view.getState()).toEqual({
			kind: 'recovery',
			diagnostic: { kind: 'write-failure' },
		});
	});

	it('waits for the shared guard and rereads settings before changing one person', async () => {
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
		const result = view.app.changeTrackingStart('42', {
			mode: 'available-recent',
		});
		await Promise.resolve();
		view.setState({
			kind: 'ready',
			settings: {
				...settings(),
				githubRequestPolicy: {
					rateLimitNotBefore: '2026-08-29T00:00:00.000Z',
				},
				followedPeople: [
					person('octocat', '42'),
					{
						...person('hubot', '7'),
						syncState: {
							...person('hubot', '7').syncState,
							lastAttemptAt: '2026-08-27T00:00:00.000Z',
						},
					},
				],
			},
		});
		expect(view.save).not.toHaveBeenCalled();
		release();
		await occupyingMutation;
		await expect(result).resolves.toMatchObject({ kind: 'updated' });
		expect(view.saved[0]?.githubRequestPolicy).toEqual({
			rateLimitNotBefore: '2026-08-29T00:00:00.000Z',
		});
		expect(view.saved[0]?.followedPeople[1]?.syncState.lastAttemptAt).toBe(
			'2026-08-27T00:00:00.000Z',
		);
	});
});

describe('FollowManagementApplication.changeNotePath', () => {
	it.each(['created', 'initialized', 'reused'] as const)(
		'prepares a %s destination before saving only the selected path change',
		async (disposition) => {
			const initial = settings();
			const view = harness(initial, {
				notePreparation: { kind: disposition },
			});
			if (disposition === 'reused')
				view.noteContents.set(
					'People/new-octocat.md',
					'existing destination note bytes',
				);
			const oldPath = initial.followedPeople[0]?.notePath;
			if (!oldPath) throw new Error('expected selected person');
			const oldNote = view.noteContents.get(oldPath);

			await expect(
				view.app.changeNotePath('42', 'People/new-octocat.md'),
			).resolves.toEqual({
				kind: 'updated',
				username: 'octocat',
				notePath: 'People/new-octocat.md',
				noteDisposition: disposition,
			});

			expect(view.prepared).toHaveLength(1);
			expect(view.prepared[0]).toMatchObject({
				path: 'People/new-octocat.md',
				identity: { username: 'octocat', githubId: '42' },
			});
			expect(
				view.prepared[0]?.transform(
					[
						'<!-- devradar:begin github="octocat" github-id="42" -->',
						'## DevRadar activity',
						'<!-- devradar:end github="octocat" github-id="42" -->',
					].join('\n'),
				),
			).toEqual({ kind: 'reuse' });
			const changed = view.saved[0]?.followedPeople[0];
			expect(changed).toEqual({
				...initial.followedPeople[0],
				notePath: 'People/new-octocat.md',
			});
			expect(view.saved[0]?.followedPeople[1]).toEqual(
				initial.followedPeople[1],
			);
			expect(view.saved[0]?.enabledActivityFamilies).toEqual(
				initial.enabledActivityFamilies,
			);
			expect(view.saved[0]?.githubRequestPolicy).toEqual(
				initial.githubRequestPolicy,
			);
			expect(view.noteContents.get(oldPath)).toBe(oldNote);
			expect(view.noteContents.has('People/new-octocat.md')).toBe(true);
		},
	);

	it('treats a case-only equivalent of the current path as unchanged', async () => {
		const view = harness();

		await expect(
			view.app.changeNotePath('42', 'people/OCTOCAT.md'),
		).resolves.toEqual({
			kind: 'unchanged',
			username: 'octocat',
			notePath: 'People/octocat.md',
		});
		expect(view.notes.prepareAssociation).not.toHaveBeenCalled();
		expect(view.save).not.toHaveBeenCalled();
	});

	it.each(['../outside.md', '/absolute.md', 'People/not-markdown.txt', ''])(
		'rejects invalid destination %s before note or settings work',
		async (path) => {
			const view = harness();

			await expect(view.app.changeNotePath('42', path)).resolves.toEqual({
				kind: 'failed',
				reason: 'invalid-input',
			});
			expect(view.notes.prepareAssociation).not.toHaveBeenCalled();
			expect(view.save).not.toHaveBeenCalled();
		},
	);

	it('rejects a case-insensitive path used by another followed person', async () => {
		const initial = settings();
		const view = harness(initial);

		await expect(
			view.app.changeNotePath('42', 'people/HUBOT.md'),
		).resolves.toEqual({ kind: 'failed', reason: 'duplicate' });
		expect(view.notes.prepareAssociation).not.toHaveBeenCalled();
		expect(view.save).not.toHaveBeenCalled();
	});

	it('fails when the account is missing or settings are in recovery', async () => {
		const view = harness();

		await expect(
			view.app.changeNotePath('missing', 'People/new.md'),
		).resolves.toEqual({ kind: 'failed', reason: 'not-followed' });
		view.setState({
			kind: 'recovery',
			diagnostic: { kind: 'write-failure' },
		});
		await expect(
			view.app.changeNotePath('42', 'People/new.md'),
		).resolves.toEqual({
			kind: 'failed',
			reason: 'settings-not-ready',
		});
		expect(view.notes.prepareAssociation).not.toHaveBeenCalled();
		expect(view.save).not.toHaveBeenCalled();
	});

	it('leaves the old path and note untouched when destination preparation fails', async () => {
		const initial = settings();
		const view = harness(initial, {
			notePreparation: {
				kind: 'failed',
				error: { kind: 'process-failure' },
			},
		});
		const oldPath = initial.followedPeople[0]?.notePath;
		if (!oldPath) throw new Error('expected selected person');
		const oldNote = view.noteContents.get(oldPath);

		await expect(
			view.app.changeNotePath('42', 'People/new-octocat.md'),
		).resolves.toEqual({ kind: 'failed', reason: 'note' });
		expect(view.save).not.toHaveBeenCalled();
		expect(view.getPersisted().followedPeople[0]?.notePath).toBe(oldPath);
		expect(view.noteContents.get(oldPath)).toBe(oldNote);
	});

	it('keeps the prior persisted destination when settings save fails after preparation', async () => {
		const initial = settings();
		const view = harness(initial, {
			notePreparation: { kind: 'created' },
			save: async () => ({ kind: 'write-failure' }),
		});
		const oldPath = initial.followedPeople[0]?.notePath;
		if (!oldPath) throw new Error('expected selected person');
		const oldNote = view.noteContents.get(oldPath);

		await expect(
			view.app.changeNotePath('42', 'People/new-octocat.md'),
		).resolves.toEqual({ kind: 'failed', reason: 'persistence' });
		expect(view.prepared.map(({ path }) => path)).toEqual([
			'People/new-octocat.md',
		]);
		expect(view.saved[0]?.followedPeople[0]?.notePath).toBe(
			'People/new-octocat.md',
		);
		expect(view.getPersisted().followedPeople[0]?.notePath).toBe(oldPath);
		expect(view.getState()).toMatchObject({ kind: 'recovery' });
		expect(view.noteContents.get(oldPath)).toBe(oldNote);
		expect(view.noteContents.has('People/new-octocat.md')).toBe(true);
	});

	it('waits for the shared guard before reading or preparing the destination', async () => {
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
		const result = view.app.changeNotePath('42', 'People/new.md');
		await Promise.resolve();
		await Promise.resolve();
		expect(view.app.isPending()).toBe(true);
		expect(view.notes.prepareAssociation).not.toHaveBeenCalled();
		release();
		await occupyingMutation;
		await expect(result).resolves.toMatchObject({ kind: 'updated' });
	});

	it('lets Sync One read the new path with the existing deduplication state', async () => {
		const initial = settings();
		const view = harness(initial);
		await expect(
			view.app.changeNotePath('42', 'People/new-octocat.md'),
		).resolves.toMatchObject({ kind: 'updated' });
		const selected = initial.followedPeople[0];
		if (!selected) throw new Error('expected selected person');
		const begin = '<!-- devradar:begin github="octocat" github-id="42" -->';
		const end = '<!-- devradar:end github="octocat" github-id="42" -->';
		const markdown = [
			begin,
			'## DevRadar activity',
			'_No activity recorded by DevRadar yet._',
			end,
		].join('\n');
		const previouslySeen = createIssueActivity({
			providerEventId: '100',
			timestamp: '2026-08-19T00:00:00Z',
			repository: 'octocat/hello-world',
			number: '5',
			title: 'Previously seen issue',
			action: 'opened',
		});
		const newActivity = createIssueActivity({
			providerEventId: '101',
			timestamp: '2026-08-27T00:00:00Z',
			repository: 'octocat/hello-world',
			number: '6',
			title: 'New issue after destination change',
			action: 'opened',
		});
		if (!previouslySeen.ok || !newActivity.ok)
			throw new Error('expected valid test activities');
		const oldPath = selected.notePath;
		const oldNote = view.noteContents.get(oldPath);
		const readPaths: string[] = [];
		const processedPaths: string[] = [];
		let destinationMarkdown = markdown;
		const notes: Pick<NotePersistence, 'read' | 'process'> = {
			read: async (path) => {
				readPaths.push(path);
				return { kind: 'read', markdown: destinationMarkdown };
			},
			process: async <TTransformError>(
				path: string,
				transform: CurrentContentTransform<TTransformError>,
			): Promise<NoteProcessResult<TTransformError>> => {
				processedPaths.push(path);
				const result = transform(destinationMarkdown);
				if (result.kind === 'reject')
					return {
						kind: 'failed',
						error: {
							kind: 'transform-rejection',
							error: result.error,
						},
					};
				destinationMarkdown = result.markdown;
				return { kind: 'changed' };
			},
		};
		const syncOne = new SyncOneApplication({
			settings: {
				getSettingsState: view.getState,
				saveCandidateWithinMutation: view.save,
			},
			github: {
				retrieveEvents: vi.fn(async () => ({
					kind: 'success' as const,
					requestAttempted: true as const,
					data: {
						activities: [previouslySeen.value, newActivity.value],
					},
					policy: {},
				})),
			},
			notes,
			mutationGuard: createApplicationMutationGuard(),
			now: () => '2026-08-28T00:00:00.000Z',
			isSupportedPlatform: () => true,
		});

		await expect(
			syncOne.syncOne({ githubAccountId: '42' }),
		).resolves.toEqual({ kind: 'updated' });

		expect(readPaths).toEqual(['People/new-octocat.md']);
		expect(processedPaths).toEqual(['People/new-octocat.md']);
		expect(destinationMarkdown).toContain(
			renderActivityEntry(newActivity.value),
		);
		expect(destinationMarkdown).not.toContain(
			renderActivityEntry(previouslySeen.value),
		);
		expect(view.noteContents.get(oldPath)).toBe(oldNote);
		const finalState = view.getState();
		expect(finalState.kind).toBe('ready');
		if (finalState.kind === 'ready') {
			const syncedPerson = finalState.settings.followedPeople.find(
				(person) => person.githubAccountId === '42',
			);
			expect(syncedPerson).toMatchObject({
				notePath: 'People/new-octocat.md',
			});
			expect(syncedPerson?.syncState.seenEvents).toHaveLength(2);
			for (const seenEvent of selected.syncState.seenEvents)
				expect(syncedPerson?.syncState.seenEvents).toContainEqual(
					seenEvent,
				);
			expect(syncedPerson?.syncState.seenEvents).toContainEqual({
				id: newActivity.value.providerEventId,
				createdAt: newActivity.value.timestamp,
			});
		}
	});
});
