import { describe, expect, it, vi } from 'vitest';
import { FollowApplication, type FollowDraft } from '../src/application/follow';
import {
	createApplicationMutationGuard,
	type ApplicationMutationGuard,
} from '../src/application/mutation-guard';
import type {
	GitHubIdentity,
	GitHubIdentityResult,
} from '../src/application/github-identity';
import type { NotePreparationResult } from '../src/application/note-persistence';
import type {
	DevRadarSettingsV1,
	FollowedPersonV1,
	PersonSyncState,
} from '../src/domain/settings';
import type {
	SettingsRuntimeState,
	SettingsSaveResult,
} from '../src/application/settings';

const NOW = '2026-08-28T00:00:00.000Z';
const OBSERVED_BOUNDARY = '2026-08-28T01:00:00.000Z';

function syncState(): PersonSyncState {
	return {
		lastAttemptAt: '2026-08-27T10:00:00.000Z',
		lastSuccessfulSyncAt: '2026-08-27T11:00:00.000Z',
		seenEvents: [{ id: '100', createdAt: '2026-08-20T10:00:00.000Z' }],
		github: { pollNotBefore: '2026-08-27T12:00:00.000Z' },
	};
}

function person(
	username = 'existing',
	githubAccountId = '7',
	notePath = 'People/existing.md',
): FollowedPersonV1 {
	return {
		username,
		githubAccountId,
		notePath,
		trackingStart: {
			mode: 'from-date',
			at: '2026-08-01T00:00:00.000Z',
		},
		syncState: syncState(),
	};
}

function settings(
	followedPeople: FollowedPersonV1[] = [person()],
): DevRadarSettingsV1 {
	return {
		schemaVersion: 1,
		followedPeople,
		githubRequestPolicy: {
			rateLimitNotBefore: '2026-08-27T00:00:00.000Z',
		},
	};
}

function draft(
	trackingStart: FollowDraft['trackingStart'] = { mode: 'available-recent' },
): FollowDraft {
	return {
		username: 'octocat',
		notePath: 'People/octocat.md',
		trackingStart,
	};
}

function identity(): GitHubIdentity {
	return { username: 'octocat', githubAccountId: '42' };
}

function identitySuccess(
	policy: GitHubIdentityResult['policy'] = {},
): GitHubIdentityResult {
	return {
		kind: 'success',
		requestAttempted: true,
		data: identity(),
		policy,
	};
}

function identityFailure(
	kind: 'person-failure' | 'provider-failure',
	policy: GitHubIdentityResult['policy'] = {},
): GitHubIdentityResult {
	return {
		kind,
		requestAttempted: true,
		policy,
	};
}

function fakeSettings(
	initial: DevRadarSettingsV1,
	save: (candidate: DevRadarSettingsV1) => SettingsSaveResult = (
		candidate,
	) => ({
		kind: 'saved',
		settings: candidate,
	}),
) {
	let state: SettingsRuntimeState = { kind: 'ready', settings: initial };
	const savedCandidates: DevRadarSettingsV1[] = [];
	const saveCandidate = vi.fn(async (candidate: DevRadarSettingsV1) => {
		savedCandidates.push(candidate);
		const result = save(candidate);
		state =
			result.kind === 'saved'
				? { kind: 'ready', settings: result.settings }
				: { kind: 'recovery', diagnostic: { kind: 'write-failure' } };
		return result;
	});
	return {
		getSettingsState: () => state,
		saveCandidate,
		saveCandidateWithinMutation: saveCandidate,
		savedCandidates,
	};
}

function fakeNotes(
	outcome: 'created' | 'transform' | 'failed' | 'reused' = 'created',
	markdown = '',
) {
	let currentMarkdown = markdown;
	const prepareAssociation = vi.fn(
		async (
			_path: string,
			_identity: { username: string; githubId: string },
			transform: (
				currentMarkdown: string,
			) =>
				| { kind: 'reuse' }
				| { kind: 'initialize'; markdown: string }
				| { kind: 'reject'; error: unknown },
		): Promise<NotePreparationResult> => {
			if (outcome === 'failed')
				return { kind: 'failed', error: { kind: 'create-failure' } };
			if (outcome === 'created') return { kind: 'created' };
			if (outcome === 'reused') return { kind: 'reused' };
			const decision = transform(currentMarkdown);
			if (decision.kind === 'reject')
				return {
					kind: 'failed',
					error: {
						kind: 'transform-rejection',
						error: decision.error as never,
					},
				};
			if (decision.kind === 'initialize')
				currentMarkdown = decision.markdown;
			return {
				kind: decision.kind === 'reuse' ? 'reused' : 'initialized',
			};
		},
	);
	return { prepareAssociation, getCurrentMarkdown: () => currentMarkdown };
}

function fakeGitHub(result: GitHubIdentityResult) {
	return { resolveIdentity: vi.fn(async () => result) };
}

function followApp(
	initial: DevRadarSettingsV1,
	result: GitHubIdentityResult,
	options: {
		notes?: ReturnType<typeof fakeNotes>;
		save?: (candidate: DevRadarSettingsV1) => SettingsSaveResult;
		mutationGuard?: ApplicationMutationGuard;
	} = {},
) {
	const settingsPort = fakeSettings(initial, options.save);
	const github = fakeGitHub(result);
	const notes = options.notes ?? fakeNotes();
	const app = new FollowApplication({
		settings: settingsPort,
		github,
		notes,
		mutationGuard:
			options.mutationGuard ?? createApplicationMutationGuard(),
		now: () => NOW,
	});
	return { app, settingsPort, github, notes };
}

describe('FollowApplication', () => {
	it('persists a complete candidate and activates only after saving', async () => {
		const initial = settings();
		const view = followApp(
			initial,
			identitySuccess({ rateLimitNotBefore: OBSERVED_BOUNDARY }),
		);

		const result = await view.app.follow(draft({ mode: 'now' }));

		expect(result).toMatchObject({
			kind: 'followed',
			person: {
				username: 'octocat',
				githubAccountId: '42',
				trackingStart: { mode: 'from-now', at: NOW },
			},
			noteDisposition: 'created',
		});
		expect(view.settingsPort.saveCandidate).toHaveBeenCalledTimes(1);
		const candidate = view.settingsPort.savedCandidates[0];
		expect(candidate?.githubRequestPolicy).toEqual({
			rateLimitNotBefore: OBSERVED_BOUNDARY,
		});
		expect(candidate?.followedPeople).toHaveLength(2);
		expect(candidate?.followedPeople[0]).not.toBe(
			initial.followedPeople[0],
		);
		expect(candidate?.followedPeople[0]?.syncState).toEqual(
			initial.followedPeople[0]?.syncState,
		);
		expect(candidate?.followedPeople[0]?.syncState).not.toBe(
			initial.followedPeople[0]?.syncState,
		);
	});

	it('persists policy only after a duplicate association', async () => {
		const initial = settings([person('octocat', '42', 'People/old.md')]);
		const view = followApp(
			initial,
			identitySuccess({ rateLimitNotBefore: OBSERVED_BOUNDARY }),
		);

		const result = await view.app.follow(draft());

		expect(result).toEqual({ kind: 'failed', reason: 'duplicate' });
		expect(view.notes.prepareAssociation).not.toHaveBeenCalled();
		expect(view.settingsPort.savedCandidates).toHaveLength(1);
		expect(view.settingsPort.savedCandidates[0]?.followedPeople).toEqual(
			initial.followedPeople,
		);
		expect(
			view.settingsPort.savedCandidates[0]?.githubRequestPolicy,
		).toEqual({
			rateLimitNotBefore: OBSERVED_BOUNDARY,
		});
	});

	it.each([
		['account ID', person('other', '42', 'People/other.md')],
		['note path', person('other', '7', 'People/octocat.md')],
	] as const)(
		'rejects duplicate %s before note preparation',
		async (_kind, existing) => {
			const view = followApp(settings([existing]), identitySuccess());

			const result = await view.app.follow(draft());

			expect(result).toEqual({ kind: 'failed', reason: 'duplicate' });
			expect(view.notes.prepareAssociation).not.toHaveBeenCalled();
			expect(view.settingsPort.saveCandidate).not.toHaveBeenCalled();
		},
	);

	it('persists policy only after note preparation fails', async () => {
		const notes = fakeNotes('failed');
		const view = followApp(
			settings(),
			identitySuccess({ rateLimitNotBefore: OBSERVED_BOUNDARY }),
			{ notes },
		);

		const result = await view.app.follow(draft());

		expect(result).toEqual({ kind: 'failed', reason: 'note' });
		expect(view.settingsPort.savedCandidates).toHaveLength(1);
		expect(view.settingsPort.savedCandidates[0]?.followedPeople).toEqual(
			settings().followedPeople,
		);
	});

	it.each(['person-failure', 'provider-failure'] as const)(
		'persists policy before returning a failed identity result (%s)',
		async (kind) => {
			const view = followApp(
				settings(),
				identityFailure(kind, {
					rateLimitNotBefore: OBSERVED_BOUNDARY,
				}),
			);

			const result = await view.app.follow(draft());

			expect(result).toEqual({ kind: 'failed', reason: 'identity' });
			expect(view.settingsPort.savedCandidates).toHaveLength(1);
			expect(
				view.settingsPort.savedCandidates[0]?.followedPeople,
			).toEqual(settings().followedPeople);
			expect(view.notes.prepareAssociation).not.toHaveBeenCalled();
		},
	);

	it('gives policy-only persistence failure precedence for failed identity', async () => {
		const view = followApp(
			settings(),
			identityFailure('person-failure', {
				rateLimitNotBefore: OBSERVED_BOUNDARY,
			}),
			{ save: () => ({ kind: 'write-failure' }) },
		);

		const result = await view.app.follow(draft());

		expect(result).toEqual({ kind: 'failed', reason: 'persistence' });
		expect(view.settingsPort.getSettingsState().kind).toBe('recovery');
		expect(view.notes.prepareAssociation).not.toHaveBeenCalled();
	});

	it('gives policy-only persistence failure precedence for duplicate failure', async () => {
		const view = followApp(
			settings([person('octocat', '42', 'People/old.md')]),
			identitySuccess({ rateLimitNotBefore: OBSERVED_BOUNDARY }),
			{ save: () => ({ kind: 'write-failure' }) },
		);

		const result = await view.app.follow(draft());

		expect(result).toEqual({ kind: 'failed', reason: 'persistence' });
		expect(view.settingsPort.getSettingsState().kind).toBe('recovery');
		expect(view.notes.prepareAssociation).not.toHaveBeenCalled();
	});

	it('does not create a policy-only save without a material observation', async () => {
		const view = followApp(settings(), identitySuccess());

		const result = await view.app.follow(draft());

		expect(result.kind).toBe('followed');
		expect(view.settingsPort.saveCandidate).toHaveBeenCalledTimes(1);
		expect(
			view.settingsPort.savedCandidates[0]?.githubRequestPolicy,
		).toEqual(settings().githubRequestPolicy);
	});

	it('leaves the candidate inactive when the final save fails', async () => {
		const view = followApp(
			settings(),
			identitySuccess({ rateLimitNotBefore: OBSERVED_BOUNDARY }),
			{ save: () => ({ kind: 'write-failure' }) },
		);

		const result = await view.app.follow(draft());

		expect(result).toEqual({ kind: 'failed', reason: 'persistence' });
		expect(view.settingsPort.getSettingsState().kind).toBe('recovery');
		expect(
			view.settingsPort.savedCandidates[0]?.followedPeople,
		).toHaveLength(2);
		expect(view.notes.prepareAssociation).toHaveBeenCalledTimes(1);
		expect(view.settingsPort.saveCandidate).toHaveBeenCalledTimes(1);
	});

	it('reuses a valid same-person managed section without erasing it', async () => {
		const managed =
			'<!-- devradar:begin github="octocat" github-id="42" -->\n' +
			'## DevRadar activity\n\n- retained\n' +
			'<!-- devradar:end github="octocat" github-id="42" -->';
		const notes = fakeNotes('transform', managed);
		const view = followApp(settings(), identitySuccess(), { notes });

		const result = await view.app.follow(draft());

		expect(result).toMatchObject({
			kind: 'followed',
			noteDisposition: 'reused',
		});
		expect(view.notes.getCurrentMarkdown()).toBe(managed);
	});

	it('initializes a marker-free existing note without erasing its content', async () => {
		const notes = fakeNotes('transform', '# Existing content\n');
		const view = followApp(settings(), identitySuccess(), { notes });

		const result = await view.app.follow(draft());

		expect(result).toMatchObject({
			kind: 'followed',
			noteDisposition: 'initialized',
		});
		expect(view.notes.getCurrentMarkdown()).toContain('# Existing content');
		expect(view.notes.getCurrentMarkdown()).toContain(
			'devradar:begin github="octocat" github-id="42"',
		);
	});

	it('fails closed on a foreign managed section without association', async () => {
		const foreign =
			'<!-- devradar:begin github="other" github-id="99" -->\n' +
			'content\n' +
			'<!-- devradar:end github="other" github-id="99" -->';
		const notes = fakeNotes('transform', foreign);
		const view = followApp(settings(), identitySuccess(), { notes });

		const result = await view.app.follow(draft());

		expect(result).toEqual({ kind: 'failed', reason: 'note' });
		expect(view.settingsPort.saveCandidate).not.toHaveBeenCalled();
		expect(view.notes.getCurrentMarkdown()).toBe(foreign);
	});

	it('returns skipped without requesting GitHub when the policy blocks it', async () => {
		const blocked = {
			...settings(),
			githubRequestPolicy: {
				rateLimitNotBefore: '2026-08-29T00:00:00.000Z',
			},
		};
		const view = followApp(blocked, identitySuccess());

		const result = await view.app.follow(draft());

		expect(result).toEqual({ kind: 'skipped', reason: 'provider-policy' });
		expect(view.github.resolveIdentity).not.toHaveBeenCalled();
		expect(view.notes.prepareAssociation).not.toHaveBeenCalled();
	});

	it('validates input before requesting GitHub', async () => {
		const view = followApp(settings(), identitySuccess());

		const result = await view.app.follow({
			...draft(),
			username: 'bad user',
		});

		expect(result).toEqual({ kind: 'failed', reason: 'invalid-input' });
		expect(view.github.resolveIdentity).not.toHaveBeenCalled();
		expect(view.notes.prepareAssociation).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: 'a non-markdown note path',
			draft: { ...draft(), notePath: 'People/octocat' },
		},
		{
			name: 'a future tracking date',
			draft: draft({ mode: 'from-date', at: '2026-08-29T00:00:00.000Z' }),
		},
	])('rejects %s before requesting GitHub', async ({ draft: input }) => {
		const view = followApp(settings(), identitySuccess());

		const result = await view.app.follow(input);

		expect(result).toEqual({ kind: 'failed', reason: 'invalid-input' });
		expect(view.github.resolveIdentity).not.toHaveBeenCalled();
	});

	it.each([
		{ mode: 'now' as const },
		{ mode: 'available-recent' as const },
		{ mode: 'from-date' as const, at: '2026-08-01T00:00:00.000Z' },
	])('supports tracking-start mode %o', async (trackingStart) => {
		const view = followApp(settings(), identitySuccess());

		const result = await view.app.follow(draft(trackingStart));

		expect(result.kind).toBe('followed');
	});
});
