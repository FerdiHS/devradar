import {
	associatePersonNote,
	parsePersonNote,
	type PersonIdentity,
} from '../domain/person-note';
import {
	canonicalizeDraftNotePath,
	createEmptyPersonSyncState,
	validateCanonicalPluginTimestamp,
	type DevRadarSettingsV1,
	type FollowedPersonV1,
} from '../domain/settings';
import {
	isCanonicalGitHubUsername,
	isCanonicalPositiveDecimalString,
} from '../domain/primitives';
import type {
	GitHubIdentity,
	GitHubIdentityRequest,
	GitHubPolicyObservation,
	GitHubResult,
} from '../adapters/github';
import type { ApplicationMutationGuard } from './mutation-guard';
import type {
	AssociationTransform,
	NotePersistence,
	NotePreparationResult,
} from './note-persistence';
import type {
	SettingsAuthority,
	SettingsRuntimeState,
	SettingsSaveResult,
} from './settings';

export type FollowTrackingStartDraft =
	| { readonly mode: 'now' }
	| { readonly mode: 'available-recent' }
	| { readonly mode: 'from-date'; readonly at: string };

export type FollowDraft = {
	readonly username: string;
	readonly notePath: string;
	readonly trackingStart: FollowTrackingStartDraft;
};

export type FollowFailureReason =
	| 'invalid-input'
	| 'settings-not-ready'
	| 'identity'
	| 'duplicate'
	| 'note'
	| 'persistence'
	| 'internal';

export type FollowResult =
	| {
			readonly kind: 'followed';
			readonly person: FollowedPersonV1;
			readonly noteDisposition: 'created' | 'initialized' | 'reused';
	  }
	| { readonly kind: 'skipped'; readonly reason: 'provider-policy' }
	| { readonly kind: 'failed'; readonly reason: FollowFailureReason };

type FollowDependencies = {
	readonly settings: Pick<
		SettingsAuthority,
		'getSettingsState' | 'saveCandidateWithinMutation'
	>;
	readonly github: {
		readonly resolveIdentity: (
			input: GitHubIdentityRequest,
		) => Promise<GitHubResult<GitHubIdentity>>;
	};
	readonly notes: Pick<NotePersistence, 'prepareAssociation'>;
	readonly mutationGuard: ApplicationMutationGuard;
	readonly now: () => string;
};

type PreparedDraft = {
	readonly username: string;
	readonly notePath: string;
	readonly trackingStart: FollowTrackingStartDraft;
};

type PolicyMerge = {
	readonly settings: DevRadarSettingsV1;
	readonly material: boolean;
};

type PolicySaveResult = { readonly ok: true } | { readonly ok: false };

const failed = (reason: FollowFailureReason): FollowResult => ({
	kind: 'failed',
	reason,
});

export class FollowApplication {
	private pending = 0;

	constructor(private readonly dependencies: FollowDependencies) {}

	isPending(): boolean {
		return this.pending > 0;
	}

	async follow(draft: FollowDraft): Promise<FollowResult> {
		this.pending += 1;
		try {
			return await this.dependencies.mutationGuard.run(() =>
				this.execute(draft),
			);
		} catch {
			return failed('internal');
		} finally {
			this.pending -= 1;
		}
	}

	private async execute(draft: FollowDraft): Promise<FollowResult> {
		const state = this.dependencies.settings.getSettingsState();
		if (state.kind !== 'ready') return failed('settings-not-ready');

		const currentInstant = this.currentInstant();
		if (!currentInstant) return failed('internal');
		const prepared = prepareDraft(draft, currentInstant);
		if (!prepared.ok) return failed('invalid-input');
		if (isBlockedByPolicy(state, currentInstant))
			return { kind: 'skipped', reason: 'provider-policy' };

		let identityResult: GitHubResult<GitHubIdentity>;
		try {
			identityResult = await this.dependencies.github.resolveIdentity({
				username: prepared.value.username,
				globalPolicy: state.settings.githubRequestPolicy,
			});
		} catch {
			return failed('internal');
		}

		if (identityResult.kind === 'no-request')
			return { kind: 'skipped', reason: 'provider-policy' };

		const policy = mergePolicy(state.settings, identityResult.policy);
		if (identityResult.kind !== 'success')
			return this.finishPreAssociationFailure(policy, 'identity');

		const identity = identityResult.data;
		if (
			!isCanonicalGitHubUsername(identity.username) ||
			!isCanonicalPositiveDecimalString(identity.githubAccountId)
		)
			return this.finishPreAssociationFailure(policy, 'identity');

		const duplicate = hasDuplicateAssociation(
			state.settings.followedPeople,
			identity,
			prepared.value.notePath,
		);
		if (duplicate)
			return this.finishPreAssociationFailure(policy, 'duplicate');

		const personIdentity: PersonIdentity = {
			username: identity.username,
			githubId: identity.githubAccountId,
		};
		let noteResult: NotePreparationResult;
		try {
			noteResult = await this.dependencies.notes.prepareAssociation(
				prepared.value.notePath,
				personIdentity,
				associationTransform(personIdentity),
			);
		} catch {
			return this.finishPreAssociationFailure(policy, 'internal');
		}
		if (noteResult.kind === 'failed')
			return this.finishPreAssociationFailure(policy, 'note');

		const commitInstant = this.currentInstant();
		if (!commitInstant)
			return this.finishPreAssociationFailure(policy, 'internal');
		const candidate = addAssociation(
			policy.settings,
			identity,
			prepared.value,
			commitInstant,
		);
		if (!candidate.ok)
			return this.finishPreAssociationFailure(policy, 'internal');

		const saveResult = await this.saveCandidate(candidate.value);
		if (saveResult.kind !== 'saved') return failed('persistence');
		return {
			kind: 'followed',
			person: candidate.value.followedPeople.at(-1) as FollowedPersonV1,
			noteDisposition: noteResult.kind,
		};
	}

	private async finishPreAssociationFailure(
		policy: PolicyMerge,
		reason: FollowFailureReason,
	): Promise<FollowResult> {
		if (!policy.material) return failed(reason);
		const saved = await this.savePolicyOnly(policy.settings);
		return saved.ok ? failed(reason) : failed('persistence');
	}

	private async savePolicyOnly(
		candidate: DevRadarSettingsV1,
	): Promise<PolicySaveResult> {
		try {
			const result =
				await this.dependencies.settings.saveCandidateWithinMutation(candidate);
			return result.kind === 'saved' ? { ok: true } : { ok: false };
		} catch {
			return { ok: false };
		}
	}

	private async saveCandidate(
		candidate: DevRadarSettingsV1,
	): Promise<SettingsSaveResult> {
		try {
			return await this.dependencies.settings.saveCandidateWithinMutation(
				candidate,
			);
		} catch {
			return { kind: 'internal-failure' };
		}
	}

	private currentInstant(): string | undefined {
		const result = validateCanonicalPluginTimestamp(
			this.dependencies.now(),
		);
		return result.ok ? result.value : undefined;
	}
}

function prepareDraft(
	draft: FollowDraft,
	currentInstant: string,
):
	| { readonly ok: true; readonly value: PreparedDraft }
	| { readonly ok: false } {
	if (!isCanonicalGitHubUsername(draft.username)) return { ok: false };
	const notePath = canonicalizeDraftNotePath(draft.notePath);
	if (!notePath.ok) return { ok: false };
	if (draft.trackingStart.mode === 'available-recent')
		return {
			ok: true,
			value: {
				username: draft.username,
				notePath: notePath.value,
				trackingStart: draft.trackingStart,
			},
		};
	if (draft.trackingStart.mode === 'now')
		return {
			ok: true,
			value: {
				username: draft.username,
				notePath: notePath.value,
				trackingStart: draft.trackingStart,
			},
		};
	const at = validateCanonicalPluginTimestamp(draft.trackingStart.at);
	if (!at.ok || at.value > currentInstant) return { ok: false };
	return {
		ok: true,
		value: {
			username: draft.username,
			notePath: notePath.value,
			trackingStart: { mode: 'from-date', at: at.value },
		},
	};
}

function isBlockedByPolicy(
	state: Extract<SettingsRuntimeState, { readonly kind: 'ready' }>,
	currentInstant: string,
): boolean {
	const boundary = state.settings.githubRequestPolicy?.rateLimitNotBefore;
	return boundary !== undefined && boundary > currentInstant;
}

function hasDuplicateAssociation(
	followedPeople: readonly FollowedPersonV1[],
	identity: GitHubIdentity,
	notePath: string,
): boolean {
	const username = identity.username.toLowerCase();
	const path = notePath.toLowerCase();
	return followedPeople.some(
		(person) =>
			person.username.toLowerCase() === username ||
			person.githubAccountId === identity.githubAccountId ||
			person.notePath.toLowerCase() === path,
	);
}

function mergePolicy(
	current: DevRadarSettingsV1,
	observation: GitHubPolicyObservation,
): PolicyMerge {
	const settings = cloneSettings(current);
	const currentBoundary = current.githubRequestPolicy?.rateLimitNotBefore;
	const observedBoundary = observation.rateLimitNotBefore;
	if (observedBoundary === undefined) return { settings, material: false };
	const boundary =
		currentBoundary === undefined || observedBoundary > currentBoundary
			? observedBoundary
			: currentBoundary;
	const material = boundary !== currentBoundary;
	if (material)
		return {
			settings: {
				...settings,
				githubRequestPolicy: {
					...(current.githubRequestPolicy ?? {}),
					rateLimitNotBefore: boundary,
				},
			},
			material: true,
		};
	return { settings, material };
}

function cloneSettings(current: DevRadarSettingsV1): DevRadarSettingsV1 {
	return {
		schemaVersion: 1,
		followedPeople: current.followedPeople.map((person) => ({
			...person,
			trackingStart:
				person.trackingStart.mode === 'available-recent'
					? { mode: 'available-recent' as const }
					: { ...person.trackingStart },
			syncState: {
				...person.syncState,
				seenEvents: person.syncState.seenEvents.map((event) => ({
					...event,
				})),
				github: { ...person.syncState.github },
			},
		})),
		...(current.githubRequestPolicy === undefined
			? {}
			: { githubRequestPolicy: { ...current.githubRequestPolicy } }),
	};
}

function addAssociation(
	current: DevRadarSettingsV1,
	identity: GitHubIdentity,
	draft: PreparedDraft,
	commitInstant: string,
):
	| { readonly ok: true; readonly value: DevRadarSettingsV1 }
	| { readonly ok: false } {
	const trackingStart =
		draft.trackingStart.mode === 'now'
			? { mode: 'from-now' as const, at: commitInstant }
			: draft.trackingStart.mode === 'available-recent'
				? { mode: 'available-recent' as const }
				: { mode: 'from-date' as const, at: draft.trackingStart.at };
	const person: FollowedPersonV1 = {
		username: identity.username,
		githubAccountId: identity.githubAccountId,
		notePath: draft.notePath,
		trackingStart,
		syncState: createEmptyPersonSyncState(),
	};
	const settings = cloneSettings(current);
	settings.followedPeople.push(person);
	return { ok: true, value: settings };
}

function associationTransform(identity: PersonIdentity): AssociationTransform {
	return (currentMarkdown) => {
		const parsed = parsePersonNote(currentMarkdown, identity);
		if (parsed.kind === 'invalid')
			return { kind: 'reject', error: parsed.error };
		if (parsed.kind === 'valid-section') return { kind: 'reuse' };
		const associated = associatePersonNote(currentMarkdown, identity, []);
		return associated.ok
			? { kind: 'initialize', markdown: associated.value.markdown }
			: { kind: 'reject', error: associated.error };
	};
}
