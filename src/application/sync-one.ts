import {
	compareCanonicalTimestamps,
	isActivityEligible,
	type Activity,
} from '../domain/activity';
import {
	parseCanonicalActivityEntries,
	parsePersonNote,
	replaceManagedEntries,
	type PersonIdentity,
	type PersonNoteFailure,
	type RetainedActivityEntry,
} from '../domain/person-note';
import {
	validateCanonicalPluginTimestamp,
	validatePersistedSettingsV1,
	type CanonicalPluginTimestamp,
	type DevRadarSettingsV1,
	type FollowedPersonV1,
} from '../domain/settings';
import { isCanonicalPositiveDecimalString } from '../domain/primitives';
import type { ApplicationMutationGuard } from './mutation-guard';
import type { NotePersistence } from './note-persistence';
import type { GitHubPolicyObservation } from './github-identity';
import type { SettingsAuthority } from './settings';
import {
	applyFailedSyncTransition,
	applySuccessfulSyncTransition,
	confirmAccounting,
	reconcileActivities,
	type ConfirmedAccounting,
	type SyncDomainError,
} from '../domain/sync';

export type SyncOneSelection = Readonly<{
	githubAccountId: string;
}>;

export type SyncOneFailureReason =
	| 'settings-not-ready'
	| 'unsupported-platform'
	| 'invalid-selection'
	| 'configuration'
	| 'provider'
	| 'note'
	| 'persistence'
	| 'internal';

export type SyncOneResult =
	| { readonly kind: 'updated' }
	| { readonly kind: 'unchanged' }
	| { readonly kind: 'skipped'; readonly reason: 'provider-policy' }
	| { readonly kind: 'failed'; readonly reason: SyncOneFailureReason };

export type SyncOneProviderResult =
	| {
			readonly kind: 'success';
			readonly requestAttempted: true;
			readonly data: { readonly activities: readonly Activity[] };
			readonly policy: GitHubPolicyObservation;
	  }
	| {
			readonly kind: 'no-request';
			readonly requestAttempted: false;
			readonly notBefore?: string;
			readonly policy: GitHubPolicyObservation;
	  }
	| {
			readonly kind: 'person-failure' | 'provider-failure';
			readonly requestAttempted: boolean;
			readonly failure: { readonly category: string };
			readonly policy: GitHubPolicyObservation;
	  };

type SyncOneEvents = {
	readonly retrieveEvents: (input: {
		readonly username: string;
		readonly githubAccountId: string;
		readonly globalPolicy?: DevRadarSettingsV1['githubRequestPolicy'];
		readonly pollNotBefore?: string;
	}) => Promise<SyncOneProviderResult>;
};

export type SyncOneDependencies = {
	readonly settings: Pick<
		SettingsAuthority,
		'getSettingsState' | 'saveCandidateWithinMutation'
	>;
	readonly github: SyncOneEvents;
	readonly notes: Pick<NotePersistence, 'read' | 'process'>;
	readonly mutationGuard: ApplicationMutationGuard;
	readonly now: () => string;
	readonly isSupportedPlatform: () => boolean;
};

type ValidPolicy = {
	readonly rateLimitNotBefore?: CanonicalPluginTimestamp;
	readonly pollNotBefore?: CanonicalPluginTimestamp;
};
type AttemptContext = {
	readonly settings: DevRadarSettingsV1;
	readonly person: FollowedPersonV1;
	readonly attemptAt: CanonicalPluginTimestamp;
	readonly policy: ValidPolicy;
};

const failed = (reason: SyncOneFailureReason): SyncOneResult => ({
	kind: 'failed',
	reason,
});

export class SyncOneApplication {
	constructor(private readonly dependencies: SyncOneDependencies) {}

	async syncOne(selection: SyncOneSelection): Promise<SyncOneResult> {
		try {
			return await this.dependencies.mutationGuard.run(() =>
				this.execute(selection),
			);
		} catch {
			return failed('internal');
		}
	}

	private async execute(selection: SyncOneSelection): Promise<SyncOneResult> {
		if (!this.dependencies.isSupportedPlatform())
			return failed('unsupported-platform');

		const runtime = this.dependencies.settings.getSettingsState();
		if (runtime.kind !== 'ready') return failed('settings-not-ready');

		const attemptAt = this.currentInstant();
		if (!attemptAt) return failed('internal');
		const selectionState = resolveSelection(runtime.settings, selection);
		if (selectionState === 'invalid-selection')
			return failed('invalid-selection');
		const settings = validatePersistedSettingsV1(
			runtime.settings,
			attemptAt,
		);
		if (!settings.ok) return failed('configuration');

		const person = resolvePerson(settings.value, selection);
		if (!person) return failed('invalid-selection');
		if (isBlockedByPolicy(settings.value, person, attemptAt))
			return { kind: 'skipped', reason: 'provider-policy' };

		let provider: SyncOneProviderResult;
		try {
			provider = await this.dependencies.github.retrieveEvents({
				username: person.username,
				githubAccountId: person.githubAccountId,
				globalPolicy: settings.value.githubRequestPolicy,
				pollNotBefore: person.syncState.github.pollNotBefore,
			});
		} catch {
			return this.finishFailure(
				{
					settings: settings.value,
					person,
					attemptAt,
					policy: {},
				},
				'internal',
			);
		}

		const policy = validatePolicy(provider.policy);
		if (!policy.ok)
			return this.finishFailure(
				{ settings: settings.value, person, attemptAt, policy: {} },
				'configuration',
			);

		if (provider.kind === 'no-request') {
			if (isApprovedPolicySkip(provider, settings.value, person))
				return { kind: 'skipped', reason: 'provider-policy' };
			return this.finishFailure(
				{
					settings: settings.value,
					person,
					attemptAt,
					policy: policy.value,
				},
				'provider',
			);
		}

		if (provider.kind !== 'success')
			return this.finishFailure(
				{
					settings: settings.value,
					person,
					attemptAt,
					policy: policy.value,
				},
				failureReasonForProvider(provider),
			);

		const eligible = filterEligibleActivities(
			provider.data.activities,
			person,
		);
		if (!eligible.ok)
			return this.finishFailure(
				{
					settings: settings.value,
					person,
					attemptAt,
					policy: policy.value,
				},
				'provider',
			);

		let noteMarkdown: string;
		try {
			const read = await this.dependencies.notes.read(person.notePath);
			if (read.kind === 'failed')
				return this.finishFailure(
					{
						settings: settings.value,
						person,
						attemptAt,
						policy: policy.value,
					},
					'note',
				);
			noteMarkdown = read.markdown;
		} catch {
			return this.finishFailure(
				{
					settings: settings.value,
					person,
					attemptAt,
					policy: policy.value,
				},
				'note',
			);
		}

		const identity: PersonIdentity = {
			username: person.username,
			githubId: person.githubAccountId,
		};
		const retained = readRetainedEntries(noteMarkdown, identity);
		if (!retained.ok)
			return this.finishFailure(
				{
					settings: settings.value,
					person,
					attemptAt,
					policy: policy.value,
				},
				'note',
			);

		const preliminary = reconcileActivities({
			activities: eligible.value,
			state: person.syncState,
			retainedEntries: retained.value,
		});
		if (!preliminary.ok)
			return this.finishFailure(
				{
					settings: settings.value,
					person,
					attemptAt,
					policy: policy.value,
				},
				failureReason(preliminary.error),
			);

		const preflight = replaceManagedEntries(
			noteMarkdown,
			identity,
			preliminary.value.finalEntries,
		);
		if (!preflight.ok)
			return this.finishFailure(
				{
					settings: settings.value,
					person,
					attemptAt,
					policy: policy.value,
				},
				'note',
			);

		let confirmation: ConfirmedAccounting = {
			kind: 'confirmed-accounting',
			activities: [],
		};
		let noteChanged = false;
		if (
			preflight.value.markdown !== noteMarkdown ||
			preliminary.value.accountingCandidates.length > 0
		) {
			let currentConfirmation: ConfirmedAccounting | undefined;
			let processed;
			try {
				processed = await this.dependencies.notes.process<
					PersonNoteFailure | SyncDomainError
				>(person.notePath, (currentMarkdown) => {
					const currentRetained = readRetainedEntries(
						currentMarkdown,
						identity,
					);
					if (!currentRetained.ok)
						return { kind: 'reject', error: currentRetained.error };
					const currentPlan = reconcileActivities({
						activities: eligible.value,
						state: person.syncState,
						retainedEntries: currentRetained.value,
					});
					if (!currentPlan.ok)
						return {
							kind: 'reject',
							error: currentPlan.error,
						};
					const replacement = replaceManagedEntries(
						currentMarkdown,
						identity,
						currentPlan.value.finalEntries,
					);
					if (!replacement.ok)
						return { kind: 'reject', error: replacement.error };
					const finalEntries = readRetainedEntries(
						replacement.value.markdown,
						identity,
					);
					if (!finalEntries.ok)
						return { kind: 'reject', error: finalEntries.error };
					const confirmed = confirmAccounting(
						finalEntries.value,
						currentPlan.value.accountingCandidates,
					);
					if (!confirmed.ok)
						return { kind: 'reject', error: confirmed.error };
					currentConfirmation = confirmed.value;
					return {
						kind: 'replace',
						markdown: replacement.value.markdown,
					};
				});
			} catch {
				return this.finishFailure(
					{
						settings: settings.value,
						person,
						attemptAt,
						policy: policy.value,
					},
					'note',
				);
			}
			if (processed.kind === 'failed' || !currentConfirmation)
				return this.finishFailure(
					{
						settings: settings.value,
						person,
						attemptAt,
						policy: policy.value,
					},
					'note',
				);
			confirmation = currentConfirmation;
			noteChanged = processed.kind === 'changed';
		}

		const completedAt = this.currentInstant();
		if (!completedAt)
			return this.finishFailure(
				{
					settings: settings.value,
					person,
					attemptAt,
					policy: policy.value,
				},
				'internal',
			);
		const transition = applySuccessfulSyncTransition(
			person.syncState,
			confirmation,
			{
				completedAt,
				lastAttemptAt: attemptAt,
				pollNotBefore: policy.value.pollNotBefore,
			},
		);
		if (!transition.ok)
			return this.finishFailure(
				{
					settings: settings.value,
					person,
					attemptAt,
					policy: policy.value,
				},
				failureReason(transition.error),
			);

		const candidate = updateSettings(
			settings.value,
			person.githubAccountId,
			transition.value,
			policy.value,
		);
		return this.saveSuccessfulCandidate(
			candidate,
			noteChanged ? 'updated' : 'unchanged',
		);
	}

	private async finishFailure(
		context: AttemptContext,
		reason: SyncOneFailureReason,
	): Promise<SyncOneResult> {
		const transition = applyFailedSyncTransition(context.person.syncState, {
			lastAttemptAt: context.attemptAt,
			pollNotBefore: context.policy.pollNotBefore,
		});
		if (!transition.ok) return failed(failureReason(transition.error));
		const candidate = updateSettings(
			context.settings,
			context.person.githubAccountId,
			transition.value,
			context.policy,
		);
		return this.saveSuccessfulCandidate(candidate, 'failed', reason);
	}

	private async saveSuccessfulCandidate(
		candidate: DevRadarSettingsV1,
		result: 'updated' | 'unchanged' | 'failed',
		reason?: SyncOneFailureReason,
	): Promise<SyncOneResult> {
		try {
			const saved =
				await this.dependencies.settings.saveCandidateWithinMutation(
					candidate,
				);
			if (saved.kind !== 'saved') return failed('persistence');
		} catch {
			return failed('persistence');
		}
		return result === 'failed'
			? failed(reason ?? 'internal')
			: { kind: result };
	}

	private currentInstant(): CanonicalPluginTimestamp | undefined {
		const result = validateCanonicalPluginTimestamp(
			this.dependencies.now(),
		);
		return result.ok ? result.value : undefined;
	}
}

function resolvePerson(
	settings: DevRadarSettingsV1,
	selection: SyncOneSelection,
): FollowedPersonV1 | undefined {
	if (
		!selection ||
		typeof selection !== 'object' ||
		typeof selection.githubAccountId !== 'string' ||
		!isCanonicalPositiveDecimalString(selection.githubAccountId)
	)
		return undefined;
	const matches = settings.followedPeople.filter(
		(person) => person.githubAccountId === selection.githubAccountId,
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function resolveSelection(
	settings: DevRadarSettingsV1,
	selection: SyncOneSelection,
): 'invalid-selection' | 'defer' {
	if (
		!selection ||
		typeof selection !== 'object' ||
		typeof selection.githubAccountId !== 'string' ||
		!isCanonicalPositiveDecimalString(selection.githubAccountId)
	)
		return 'invalid-selection';
	if (!Array.isArray(settings.followedPeople)) return 'defer';
	let matches = 0;
	for (const person of settings.followedPeople) {
		if (
			person !== null &&
			typeof person === 'object' &&
			typeof person.githubAccountId === 'string' &&
			person.githubAccountId === selection.githubAccountId
		) {
			matches += 1;
			if (matches > 1) return 'invalid-selection';
		}
	}
	return matches === 0 ? 'invalid-selection' : 'defer';
}

function isBlockedByPolicy(
	settings: DevRadarSettingsV1,
	person: FollowedPersonV1,
	now: string,
): boolean {
	return [
		settings.githubRequestPolicy?.rateLimitNotBefore,
		person.syncState.github.pollNotBefore,
	].some(
		(boundary) =>
			boundary !== undefined &&
			compareCanonicalTimestamps(boundary, now) > 0,
	);
}

function isApprovedPolicySkip(
	provider: Extract<SyncOneProviderResult, { readonly kind: 'no-request' }>,
	settings: DevRadarSettingsV1,
	person: FollowedPersonV1,
): boolean {
	const returned = provider.notBefore;
	if (!returned) return false;
	const valid = validateCanonicalPluginTimestamp(returned);
	if (!valid.ok) return false;
	const configured = [
		settings.githubRequestPolicy?.rateLimitNotBefore,
		person.syncState.github.pollNotBefore,
	].filter((boundary): boundary is string => boundary !== undefined);
	if (configured.length === 0) return false;
	const latest = configured.reduce((current, boundary) =>
		compareCanonicalTimestamps(boundary, current) > 0 ? boundary : current,
	);
	return compareCanonicalTimestamps(latest, valid.value) === 0;
}

function filterEligibleActivities(
	activities: readonly Activity[],
	person: FollowedPersonV1,
):
	| { readonly ok: true; readonly value: readonly Activity[] }
	| { readonly ok: false } {
	const eligible: Activity[] = [];
	for (const activity of activities) {
		const result = isActivityEligible(
			activity.timestamp,
			person.trackingStart,
		);
		if (!result.ok) return { ok: false };
		if (result.value) eligible.push(activity);
	}
	return { ok: true, value: eligible };
}

function readRetainedEntries(
	markdown: string,
	identity: PersonIdentity,
):
	| { readonly ok: true; readonly value: readonly RetainedActivityEntry[] }
	| { readonly ok: false; readonly error: PersonNoteFailure } {
	const parsed = parsePersonNote(markdown, identity);
	if (parsed.kind === 'invalid') return { ok: false, error: parsed.error };
	if (parsed.kind === 'marker-free')
		return {
			ok: false,
			error: {
				kind: 'missing-marker',
				missing: 'associated-section',
			},
		};
	return {
		ok: true,
		value: parseCanonicalActivityEntries(parsed.section.managedContent),
	};
}

function validatePolicy(
	policy: GitHubPolicyObservation,
): { readonly ok: true; readonly value: ValidPolicy } | { readonly ok: false } {
	const rateLimitNotBefore =
		policy.rateLimitNotBefore === undefined
			? undefined
			: validateCanonicalPluginTimestamp(policy.rateLimitNotBefore);
	const pollNotBefore =
		policy.pollNotBefore === undefined
			? undefined
			: validateCanonicalPluginTimestamp(policy.pollNotBefore);
	if (
		(rateLimitNotBefore && !rateLimitNotBefore.ok) ||
		(pollNotBefore && !pollNotBefore.ok)
	)
		return { ok: false };
	return {
		ok: true,
		value: {
			...(rateLimitNotBefore?.ok
				? { rateLimitNotBefore: rateLimitNotBefore.value }
				: {}),
			...(pollNotBefore?.ok
				? { pollNotBefore: pollNotBefore.value }
				: {}),
		},
	};
}

function updateSettings(
	settings: DevRadarSettingsV1,
	githubAccountId: string,
	syncState: FollowedPersonV1['syncState'],
	policy: ValidPolicy,
): DevRadarSettingsV1 {
	const updated: DevRadarSettingsV1 = {
		...settings,
		followedPeople: settings.followedPeople.map((person) =>
			person.githubAccountId === githubAccountId
				? { ...person, syncState }
				: person,
		),
		...(policy.rateLimitNotBefore !== undefined &&
		(settings.githubRequestPolicy?.rateLimitNotBefore === undefined ||
			compareCanonicalTimestamps(
				policy.rateLimitNotBefore,
				settings.githubRequestPolicy.rateLimitNotBefore,
			) > 0)
			? {
					githubRequestPolicy: {
						...(settings.githubRequestPolicy ?? {}),
						rateLimitNotBefore: policy.rateLimitNotBefore,
					},
				}
			: {}),
	};
	return updated;
}

function failureReason(error: SyncDomainError): SyncOneFailureReason {
	return error.kind === 'unconfirmed-accounting' ? 'note' : 'provider';
}

function failureReasonForProvider(
	provider: Extract<
		SyncOneProviderResult,
		{ readonly kind: 'person-failure' | 'provider-failure' }
	>,
): SyncOneFailureReason {
	return provider.failure.category === 'invalid-input' ||
		provider.failure.category === 'invalid-policy'
		? 'configuration'
		: 'provider';
}
