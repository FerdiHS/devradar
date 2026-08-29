import { describe, expect, it, vi } from 'vitest';
import { createIssueActivity, type Activity } from '../src/domain/activity';
import { renderActivityEntry } from '../src/domain/person-note';
import type { ApplicationMutationGuard } from '../src/application/mutation-guard';
import {
	SyncOneApplication,
	type SyncOneDependencies,
	type SyncOneProviderResult,
} from '../src/application/sync-one';
import type { GitHubPolicyObservation } from '../src/application/github-identity';
import {
	createEmptyPersonSyncState,
	type DevRadarSettingsV1,
} from '../src/domain/settings';
import {
	SettingsApplication,
	type SettingsRuntimeState,
} from '../src/application/settings';
import type {
	CurrentContentTransform,
	NoteProcessResult,
} from '../src/application/note-persistence';

const begin = '<!-- devradar:begin github="octocat" github-id="583231" -->';
const end = '<!-- devradar:end github="octocat" github-id="583231" -->';
const note = (body = '\n_No activity recorded by DevRadar yet._') =>
	[begin, '## DevRadar activity', body, end].join('\n');

const activity = (
	providerEventId: string,
	timestamp = '2026-08-18T03:00:00Z',
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

const settings = (
	overrides: Partial<DevRadarSettingsV1> = {},
): DevRadarSettingsV1 => ({
	schemaVersion: 1,
	followedPeople: [
		{
			username: 'octocat',
			githubAccountId: '583231',
			notePath: 'People/octocat.md',
			trackingStart: { mode: 'available-recent' },
			syncState: createEmptyPersonSyncState(),
		},
	],
	...overrides,
});

const ready = (value = settings()): SettingsRuntimeState => ({
	kind: 'ready',
	settings: value,
});

const successfulProvider = (
	activities: readonly Activity[],
	policy: GitHubPolicyObservation = {},
): SyncOneProviderResult => ({
	kind: 'success',
	requestAttempted: true,
	data: { activities },
	policy,
});

const dependencies = (
	value = settings(),
	providerResult: SyncOneProviderResult = successfulProvider([]),
) => {
	let current = value;
	const saveCandidateWithinMutation = vi.fn(
		async (candidate: DevRadarSettingsV1) => {
			current = candidate;
			return { kind: 'saved' as const, settings: candidate };
		},
	);
	const settingsAuthority = {
		getSettingsState: vi.fn(() => ready(current)),
		saveCandidateWithinMutation,
	};
	const process = vi.fn(
		async <T>(
			_path: string,
			transform: (markdown: string) => unknown,
		): Promise<NoteProcessResult<T>> => {
			transform(note());
			return { kind: 'changed' };
		},
	);
	const notes = {
		read: vi.fn(async () => ({ kind: 'read' as const, markdown: note() })),
		process,
	};
	const github = {
		retrieveEvents: vi.fn(async () => providerResult),
	};
	const mutationGuard: ApplicationMutationGuard = {
		run: async <T>(operation: () => Promise<T>) => operation(),
	};
	const deps: SyncOneDependencies = {
		settings: settingsAuthority,
		github,
		notes: notes as unknown as SyncOneDependencies['notes'],
		mutationGuard,
		now: vi
			.fn()
			.mockReturnValueOnce('2026-08-20T12:00:00.000Z')
			.mockReturnValue('2026-08-20T12:01:00.000Z'),
		isSupportedPlatform: () => true,
	};
	return { deps, github, notes, mutationGuard, saveCandidateWithinMutation };
};

describe('Sync One application', () => {
	it('holds the shared mutation guard through retrieval, note work, and state save', async () => {
		const newActivity = activity('4');
		const fakes = dependencies(
			settings(),
			successfulProvider([newActivity]),
		);
		const trace: string[] = [];
		fakes.mutationGuard.run = async <T>(operation: () => Promise<T>) => {
			trace.push('enter');
			try {
				return await operation();
			} finally {
				trace.push('exit');
			}
		};
		fakes.github.retrieveEvents.mockImplementation(async () => {
			trace.push('provider');
			return successfulProvider([newActivity]);
		});
		fakes.notes.read.mockImplementation(async () => {
			trace.push('read');
			return { kind: 'read', markdown: note() };
		});
		fakes.notes.process.mockImplementation(async (_path, transform) => {
			trace.push('process');
			transform(note());
			return { kind: 'changed' };
		});
		fakes.saveCandidateWithinMutation.mockImplementation(
			async (candidate) => {
				trace.push('save');
				return { kind: 'saved', settings: candidate };
			},
		);

		const application = new SyncOneApplication(fakes.deps);
		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'updated' });
		expect(trace).toEqual([
			'enter',
			'provider',
			'read',
			'process',
			'save',
			'exit',
		]);
	});

	it('fails closed on unsupported platforms before provider or note work', async () => {
		const fakes = dependencies();
		const application = new SyncOneApplication({
			...fakes.deps,
			isSupportedPlatform: () => false,
		});

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({
			kind: 'failed',
			reason: 'unsupported-platform',
		});
		expect(fakes.github.retrieveEvents).not.toHaveBeenCalled();
		expect(fakes.notes.read).not.toHaveBeenCalled();
	});

	it('updates the note and persists confirmed sync state by durable account ID', async () => {
		const newActivity = activity('1');
		const fakes = dependencies(
			settings(),
			successfulProvider([newActivity]),
		);
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'updated' });
		expect(fakes.github.retrieveEvents).toHaveBeenCalledWith(
			expect.objectContaining({
				username: 'octocat',
				githubAccountId: '583231',
			}),
		);
		expect(fakes.saveCandidateWithinMutation).toHaveBeenCalledTimes(1);
		expect(
			fakes.saveCandidateWithinMutation.mock.calls[0]?.[0]
				.followedPeople[0]?.syncState,
		).toMatchObject({
			lastSuccessfulSyncAt: '2026-08-20T12:01:00.000Z',
			lastAttemptAt: '2026-08-20T12:00:00.000Z',
			seenEvents: [{ id: '1', createdAt: newActivity.timestamp }],
		});
	});

	it('does not process an identical note when no note-derived accounting is needed', async () => {
		const fakes = dependencies();
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'unchanged' });
		expect(fakes.notes.read).toHaveBeenCalledTimes(1);
		expect(fakes.notes.process).not.toHaveBeenCalled();
	});

	it('reprocesses current content when reconciliation needs accounting even if Markdown is unchanged', async () => {
		const existing = activity('1');
		const fakes = dependencies(
			settings({
				followedPeople: [
					{
						...settings().followedPeople[0]!,
						syncState: createEmptyPersonSyncState(),
					},
				],
			}),
			successfulProvider([existing]),
		);
		fakes.notes.read.mockResolvedValue({
			kind: 'read',
			markdown: note(`\n${renderActivityEntry(existing)}\n`),
		});
		fakes.notes.process.mockImplementation(async (_path, transform) => {
			transform(note(`\n${renderActivityEntry(existing)}\n`));
			return { kind: 'unchanged' };
		});
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'unchanged' });
		expect(fakes.notes.process).toHaveBeenCalledTimes(1);
		expect(
			fakes.saveCandidateWithinMutation.mock.calls[0]?.[0]
				.followedPeople[0]?.syncState.seenEvents,
		).toEqual([{ id: '1', createdAt: existing.timestamp }]);
	});

	it('recomputes against current Markdown supplied by the note mutation callback', async () => {
		const newActivity = activity('2', '2026-08-19T03:00:00Z', 'new');
		const retainedActivity = activity(
			'1',
			'2026-08-18T03:00:00Z',
			'retained',
		);
		const fakes = dependencies(
			settings(),
			successfulProvider([newActivity]),
		);
		const currentMarkdown = note(
			`\n${renderActivityEntry(retainedActivity)}\n`,
		);
		fakes.notes.read.mockResolvedValue({
			kind: 'read',
			markdown: note(),
		});
		fakes.notes.process.mockImplementation(async (_path, transform) => {
			const result = (transform as CurrentContentTransform<unknown>)(
				currentMarkdown,
			);
			if (result.kind !== 'replace')
				throw new Error('unexpected current-content rejection');
			expect(result.markdown).toContain(
				renderActivityEntry(retainedActivity),
			);
			expect(result.markdown).toContain(renderActivityEntry(newActivity));
			return { kind: 'changed' };
		});

		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'updated' });
		expect(fakes.notes.process).toHaveBeenCalledTimes(1);
	});

	it('persists observed polling and global rate-limit boundaries on success', async () => {
		const fakes = dependencies(
			settings(),
			successfulProvider([], {
				pollNotBefore: '2026-08-20T12:10:00.000Z',
				rateLimitNotBefore: '2026-08-20T12:20:00.000Z',
			}),
		);
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'unchanged' });
		const saved = fakes.saveCandidateWithinMutation.mock.calls[0]?.[0];
		expect(saved?.githubRequestPolicy).toEqual({
			rateLimitNotBefore: '2026-08-20T12:20:00.000Z',
		});
		expect(saved?.followedPeople[0]?.syncState.github).toEqual({
			pollNotBefore: '2026-08-20T12:10:00.000Z',
		});
	});

	it('returns skipped without work when a person policy boundary is in the future', async () => {
		const value = settings({
			followedPeople: [
				{
					...settings().followedPeople[0]!,
					syncState: {
						...settings().followedPeople[0]!.syncState,
						github: { pollNotBefore: '2026-08-21T00:00:00.000Z' },
					},
				},
			],
		});
		const fakes = dependencies(value);
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'skipped', reason: 'provider-policy' });
		expect(fakes.github.retrieveEvents).not.toHaveBeenCalled();
		expect(fakes.notes.read).not.toHaveBeenCalled();
		expect(fakes.saveCandidateWithinMutation).not.toHaveBeenCalled();
	});

	it('fails stale durable selections before provider or note work', async () => {
		const fakes = dependencies();
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '999999' });

		expect(result).toEqual({ kind: 'failed', reason: 'invalid-selection' });
		expect(fakes.github.retrieveEvents).not.toHaveBeenCalled();
		expect(fakes.notes.read).not.toHaveBeenCalled();
	});

	it('treats a non-policy zero-request result as a failed attempted execution', async () => {
		const fakes = dependencies(settings(), {
			kind: 'provider-failure',
			requestAttempted: false,
			failure: { category: 'transport-contract' },
			policy: {},
		});
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'failed', reason: 'provider' });
		expect(
			fakes.saveCandidateWithinMutation.mock.calls[0]?.[0]
				.followedPeople[0]?.syncState.lastAttemptAt,
		).toBe('2026-08-20T12:00:00.000Z');
	});

	it('classifies invalid provider policy as configuration while recording the attempt', async () => {
		const fakes = dependencies(settings(), {
			kind: 'provider-failure',
			requestAttempted: false,
			failure: { category: 'invalid-policy' },
			policy: {},
		});
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'failed', reason: 'configuration' });
		expect(
			fakes.saveCandidateWithinMutation.mock.calls[0]?.[0]
				.followedPeople[0]?.syncState.lastAttemptAt,
		).toBe('2026-08-20T12:00:00.000Z');
	});

	it('persists valid policy observations on a failed provider execution', async () => {
		const fakes = dependencies(settings(), {
			kind: 'provider-failure',
			requestAttempted: true,
			failure: { category: 'transport-contract' },
			policy: {
				pollNotBefore: '2026-08-20T12:10:00.000Z',
				rateLimitNotBefore: '2026-08-20T12:20:00.000Z',
			},
		});
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'failed', reason: 'provider' });
		const saved = fakes.saveCandidateWithinMutation.mock.calls[0]?.[0];
		expect(saved?.githubRequestPolicy).toEqual({
			rateLimitNotBefore: '2026-08-20T12:20:00.000Z',
		});
		expect(saved?.followedPeople[0]?.syncState).toMatchObject({
			lastAttemptAt: '2026-08-20T12:00:00.000Z',
			github: { pollNotBefore: '2026-08-20T12:10:00.000Z' },
		});
	});

	it('keeps the note and enters settings recovery when state persistence fails, then recovers canonically', async () => {
		const newActivity = activity('3');
		const initialSettings = settings();
		let noteMarkdown = note();
		let saveCalls = 0;
		const persistence = {
			load: vi.fn(async () => ({
				kind: 'loaded' as const,
				settings: initialSettings,
			})),
			save: vi.fn(async (candidate: DevRadarSettingsV1) => {
				saveCalls += 1;
				if (saveCalls === 1) return { kind: 'write-failure' as const };
				return { kind: 'saved' as const, settings: candidate };
			}),
		};
		const mutationGuard: ApplicationMutationGuard = {
			run: async <T>(operation: () => Promise<T>) => operation(),
		};
		const settingsAuthority = new SettingsApplication(
			persistence,
			() => true,
			mutationGuard,
		);
		await settingsAuthority.load();
		const notes: SyncOneDependencies['notes'] = {
			read: vi.fn(async () => ({
				kind: 'read' as const,
				markdown: noteMarkdown,
			})),
			process: async <T>(
				_path: string,
				transform: CurrentContentTransform<T>,
			): Promise<NoteProcessResult<T>> => {
				const result = transform(noteMarkdown);
				if (result.kind === 'reject')
					return {
						kind: 'failed',
						error: {
							kind: 'transform-rejection',
							error: result.error,
						},
					};
				const changed = result.markdown !== noteMarkdown;
				noteMarkdown = result.markdown;
				return { kind: changed ? 'changed' : 'unchanged' };
			},
		};
		const github = {
			retrieveEvents: vi.fn(async () =>
				successfulProvider([newActivity]),
			),
		};
		const now = vi
			.fn()
			.mockReturnValueOnce('2026-08-20T12:00:00.000Z')
			.mockReturnValue('2026-08-20T12:01:00.000Z');
		const application = new SyncOneApplication({
			settings: settingsAuthority,
			github,
			notes,
			mutationGuard,
			now,
			isSupportedPlatform: () => true,
		});

		const first = await application.syncOne({ githubAccountId: '583231' });

		expect(first).toEqual({ kind: 'failed', reason: 'persistence' });
		expect(noteMarkdown).toContain(renderActivityEntry(newActivity));
		expect(settingsAuthority.getSettingsState()).toEqual({
			kind: 'recovery',
			diagnostic: { kind: 'write-failure' },
		});
		const blocked = await application.syncOne({
			githubAccountId: '583231',
		});
		expect(blocked).toEqual({
			kind: 'failed',
			reason: 'settings-not-ready',
		});
		expect(github.retrieveEvents).toHaveBeenCalledTimes(1);

		await settingsAuthority.retrySettingsLoad();
		const recovered = await application.syncOne({
			githubAccountId: '583231',
		});

		expect(recovered).toEqual({ kind: 'unchanged' });
		expect(github.retrieveEvents).toHaveBeenCalledTimes(2);
		expect(persistence.save).toHaveBeenCalledTimes(2);
		expect(
			persistence.save.mock.calls[1]?.[0].followedPeople[0]?.syncState
				.seenEvents,
		).toEqual([{ id: '3', createdAt: newActivity.timestamp }]);
	});
});
