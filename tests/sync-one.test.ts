import { describe, expect, it, vi } from 'vitest';
import {
	createIssueActivity,
	createPullRequestActivity,
	type Activity,
} from '../src/domain/activity';
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

const detailPullRequestActivity = (providerEventId: string, title: string) => {
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
		read: vi.fn<SyncOneDependencies['notes']['read']>(async () => ({
			kind: 'read',
			markdown: note(),
		})),
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

	it('waits for provider completion before accessing the note', async () => {
		const fakes = dependencies();
		let resolveProvider!: (result: SyncOneProviderResult) => void;
		const providerPending = new Promise<SyncOneProviderResult>(
			(resolve) => {
				resolveProvider = resolve;
			},
		);
		fakes.github.retrieveEvents.mockReturnValue(providerPending);
		const application = new SyncOneApplication(fakes.deps);

		const sync = application.syncOne({ githubAccountId: '583231' });
		await Promise.resolve();

		expect(fakes.notes.read).not.toHaveBeenCalled();
		expect(fakes.notes.process).not.toHaveBeenCalled();
		resolveProvider(successfulProvider([]));

		await expect(sync).resolves.toEqual({ kind: 'unchanged' });
		expect(fakes.notes.read).toHaveBeenCalledTimes(1);
	});

	it('delegates tracking-start filtering before note reconciliation', async () => {
		const beforeStart = activity('10', '2026-08-19T23:59:59Z');
		const atStart = activity('11', '2026-08-20T00:00:00Z');
		const value = settings({
			followedPeople: [
				{
					...settings().followedPeople[0]!,
					trackingStart: {
						mode: 'from-date',
						at: '2026-08-20T00:00:00.000Z',
					},
				},
			],
		});
		const fakes = dependencies(
			value,
			successfulProvider([beforeStart, atStart]),
		);
		fakes.notes.process.mockImplementation(async (_path, transform) => {
			const result = (transform as CurrentContentTransform<unknown>)(
				note(),
			);
			if (result.kind !== 'replace')
				throw new Error('unexpected current-content rejection');
			expect(result.markdown).not.toContain(
				renderActivityEntry(beforeStart),
			);
			expect(result.markdown).toContain(renderActivityEntry(atStart));
			return { kind: 'changed' };
		});
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'updated' });
		expect(
			fakes.saveCandidateWithinMutation.mock.calls[0]?.[0]
				.followedPeople[0]?.syncState.seenEvents,
		).toEqual([{ id: '11', createdAt: atStart.timestamp }]);
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

	it('rereads authoritative person settings inside the mutation guard', async () => {
		const authoritative = settings({
			followedPeople: [
				{
					...settings().followedPeople[0]!,
					username: 'current-octocat',
					notePath: 'People/current-octocat.md',
				},
			],
		});
		const fakes = dependencies();
		fakes.notes.read.mockResolvedValue({
			kind: 'read',
			markdown: note().replaceAll('octocat', 'current-octocat'),
		});
		fakes.mutationGuard.run = async <T>(operation: () => Promise<T>) => {
			vi.spyOn(fakes.deps.settings, 'getSettingsState').mockReturnValue(
				ready(authoritative),
			);
			return operation();
		};

		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'unchanged' });
		expect(fakes.github.retrieveEvents).toHaveBeenCalledWith(
			expect.objectContaining({
				username: 'current-octocat',
				githubAccountId: '583231',
			}),
		);
		expect(fakes.notes.read).toHaveBeenCalledWith(
			'People/current-octocat.md',
		);
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

	it('returns skipped without work when a global policy boundary is in the future', async () => {
		const value = settings({
			githubRequestPolicy: {
				rateLimitNotBefore: '2026-08-21T00:00:00.000Z',
			},
		});
		const fakes = dependencies(value);
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'skipped', reason: 'provider-policy' });
		expect(fakes.github.retrieveEvents).not.toHaveBeenCalled();
		expect(fakes.notes.read).not.toHaveBeenCalled();
		expect(fakes.saveCandidateWithinMutation).not.toHaveBeenCalled();
	});

	it('honors a provider policy skip at the application decision boundary', async () => {
		const boundary = '2026-08-20T12:00:00.000Z';
		const fakes = dependencies(
			settings({
				githubRequestPolicy: { rateLimitNotBefore: boundary },
			}),
			{
				kind: 'no-request',
				requestAttempted: false,
				notBefore: boundary,
				policy: {},
			},
		);
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'skipped', reason: 'provider-policy' });
		expect(fakes.github.retrieveEvents).toHaveBeenCalledOnce();
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

	it('fails duplicate durable selections before provider or note work', async () => {
		const fakes = dependencies(
			settings({
				followedPeople: [
					...settings().followedPeople,
					{
						username: 'hubot',
						githubAccountId: '583231',
						notePath: 'People/hubot.md',
						trackingStart: { mode: 'available-recent' },
						syncState: createEmptyPersonSyncState(),
					},
				],
			}),
		);
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'failed', reason: 'invalid-selection' });
		expect(fakes.github.retrieveEvents).not.toHaveBeenCalled();
		expect(fakes.notes.read).not.toHaveBeenCalled();
	});

	it('returns a note failure when the associated note cannot be read', async () => {
		const fakes = dependencies();
		fakes.notes.read.mockResolvedValue({
			kind: 'failed',
			error: { kind: 'read-failure' },
		});
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'failed', reason: 'note' });
		expect(fakes.saveCandidateWithinMutation).toHaveBeenCalledOnce();
	});

	it('returns an internal failure when a provider capability rejects', async () => {
		const fakes = dependencies();
		fakes.github.retrieveEvents.mockRejectedValue(new Error('boom'));
		const application = new SyncOneApplication(fakes.deps);

		const result = await application.syncOne({ githubAccountId: '583231' });

		expect(result).toEqual({ kind: 'failed', reason: 'internal' });
		expect(fakes.saveCandidateWithinMutation).toHaveBeenCalledOnce();
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
		const firstActivity = detailPullRequestActivity('3', 'Title A');
		const recoveredActivity = detailPullRequestActivity('3', 'Title B');
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
			retrieveEvents: vi
				.fn()
				.mockResolvedValueOnce(successfulProvider([firstActivity]))
				.mockResolvedValueOnce(successfulProvider([recoveredActivity])),
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
		expect(noteMarkdown).toContain(renderActivityEntry(firstActivity));
		expect(noteMarkdown).not.toContain(
			renderActivityEntry(recoveredActivity),
		);
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
		).toEqual([{ id: '3', createdAt: firstActivity.timestamp }]);
	});
});
