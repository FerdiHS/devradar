import { compareCanonicalTimestamps } from '../domain/activity';
import {
	validateCanonicalPluginTimestamp,
	canonicalizeDraftNotePath,
	type DevRadarSettingsV3,
	type FollowedPersonV1,
} from '../domain/settings';
import type { PersonIdentity } from '../domain/person-note';
import { associationTransform, type FollowTrackingStartDraft } from './follow';
import type { ApplicationMutationGuard } from './mutation-guard';
import type {
	NotePersistence,
	NotePreparationResult,
} from './note-persistence';
import type {
	SettingsAuthority,
	SettingsRuntimeState,
	SettingsSaveResult,
} from './settings';

export type UnfollowFailureReason =
	'settings-not-ready' | 'not-followed' | 'persistence' | 'internal';

export type UnfollowResult =
	| { readonly kind: 'unfollowed'; readonly username: string }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'failed'; readonly reason: UnfollowFailureReason };

export type TrackingStartChangeFailureReason =
	| 'invalid-input'
	| 'settings-not-ready'
	| 'not-followed'
	| 'persistence'
	| 'internal';

export type TrackingStartChangeResult =
	| {
			readonly kind: 'updated';
			readonly username: string;
			readonly trackingStart: FollowedPersonV1['trackingStart'];
	  }
	| {
			readonly kind: 'failed';
			readonly reason: TrackingStartChangeFailureReason;
	  };

export type NotePathChangeFailureReason =
	| 'invalid-input'
	| 'settings-not-ready'
	| 'not-followed'
	| 'duplicate'
	| 'note'
	| 'persistence'
	| 'internal';

export type PreparedNotePathDestination = {
	readonly username: string;
	readonly previousPath: string;
	readonly preparedPath: string;
};

export type NotePathChangeFailure = {
	readonly kind: 'failed';
	readonly reason: NotePathChangeFailureReason;
	readonly preparedDestination?: PreparedNotePathDestination;
};

export type NotePathChangeResult =
	| {
			readonly kind: 'updated';
			readonly username: string;
			readonly notePath: string;
			readonly noteDisposition: 'created' | 'initialized' | 'reused';
	  }
	| {
			readonly kind: 'unchanged';
			readonly username: string;
			readonly notePath: string;
	  }
	| NotePathChangeFailure;

type FollowManagementDependencies = {
	readonly settings: Pick<
		SettingsAuthority,
		'getSettingsState' | 'saveCandidateWithinMutation'
	>;
	readonly notes: Pick<NotePersistence, 'prepareAssociation'>;
	readonly mutationGuard: ApplicationMutationGuard;
	readonly confirmUnfollow: (message: string) => boolean;
	readonly now: () => string;
};

const failed = (reason: UnfollowFailureReason): UnfollowResult => ({
	kind: 'failed',
	reason,
});

const trackingStartFailed = (
	reason: TrackingStartChangeFailureReason,
): TrackingStartChangeResult => ({ kind: 'failed', reason });

const notePathFailed = (
	reason: NotePathChangeFailureReason,
	preparedDestination?: PreparedNotePathDestination,
): NotePathChangeResult => ({
	kind: 'failed',
	reason,
	...(preparedDestination ? { preparedDestination } : {}),
});

export class FollowManagementApplication {
	private pending = 0;

	constructor(private readonly dependencies: FollowManagementDependencies) {}

	isPending(): boolean {
		return this.pending > 0;
	}

	async unfollow(githubAccountId: string): Promise<UnfollowResult> {
		this.pending += 1;
		try {
			const initial = this.dependencies.settings.getSettingsState();
			if (initial.kind !== 'ready') return failed('settings-not-ready');
			const selected = findPerson(initial, githubAccountId);
			if (!selected) return failed('not-followed');

			let confirmed: boolean;
			try {
				confirmed = this.dependencies.confirmUnfollow(
					unfollowConfirmation(selected.username),
				);
			} catch {
				return failed('internal');
			}
			if (!confirmed) return { kind: 'cancelled' };

			return await this.dependencies.mutationGuard.run(async () => {
				const current = this.dependencies.settings.getSettingsState();
				if (current.kind !== 'ready')
					return failed('settings-not-ready');
				const person = findPerson(current, githubAccountId);
				if (!person) return failed('not-followed');

				const candidate: DevRadarSettingsV3 = {
					...current.settings,
					followedPeople: current.settings.followedPeople.filter(
						(item) => item.githubAccountId !== githubAccountId,
					),
				};
				let saved: SettingsSaveResult;
				try {
					saved =
						await this.dependencies.settings.saveCandidateWithinMutation(
							candidate,
						);
				} catch {
					return failed('internal');
				}
				if (saved.kind !== 'saved')
					return saved.kind === 'internal-failure'
						? failed('internal')
						: failed('persistence');
				return { kind: 'unfollowed', username: person.username };
			});
		} catch {
			return failed('internal');
		} finally {
			this.pending -= 1;
		}
	}

	async changeTrackingStart(
		githubAccountId: string,
		draft: FollowTrackingStartDraft,
	): Promise<TrackingStartChangeResult> {
		this.pending += 1;
		try {
			return await this.dependencies.mutationGuard.run(async () => {
				const state = this.dependencies.settings.getSettingsState();
				if (state.kind !== 'ready')
					return trackingStartFailed('settings-not-ready');
				const selected = findPerson(state, githubAccountId);
				if (!selected) return trackingStartFailed('not-followed');

				const trackingStart = this.prepareTrackingStart(draft);
				if (!trackingStart.ok)
					return trackingStartFailed(trackingStart.reason);
				const candidate: DevRadarSettingsV3 = {
					...state.settings,
					followedPeople: state.settings.followedPeople.map(
						(person) =>
							person.githubAccountId === githubAccountId
								? {
										...person,
										trackingStart: trackingStart.value,
									}
								: person,
					),
				};
				let saved: SettingsSaveResult;
				try {
					saved =
						await this.dependencies.settings.saveCandidateWithinMutation(
							candidate,
						);
				} catch {
					return trackingStartFailed('internal');
				}
				if (saved.kind !== 'saved')
					return trackingStartFailed(
						saved.kind === 'internal-failure'
							? 'internal'
							: 'persistence',
					);
				return {
					kind: 'updated',
					username: selected.username,
					trackingStart: trackingStart.value,
				};
			});
		} catch {
			return trackingStartFailed('internal');
		} finally {
			this.pending -= 1;
		}
	}

	async changeNotePath(
		githubAccountId: string,
		draftPath: string,
	): Promise<NotePathChangeResult> {
		this.pending += 1;
		try {
			return await this.dependencies.mutationGuard.run(async () => {
				const state = this.dependencies.settings.getSettingsState();
				if (state.kind !== 'ready')
					return notePathFailed('settings-not-ready');
				const selected = findPerson(state, githubAccountId);
				if (!selected) return notePathFailed('not-followed');

				const destination = canonicalizeDraftNotePath(draftPath);
				if (!destination.ok) return notePathFailed('invalid-input');
				const notePath = destination.value;
				if (notePath.toLowerCase() === selected.notePath.toLowerCase())
					return {
						kind: 'unchanged',
						username: selected.username,
						notePath: selected.notePath,
					};
				if (
					state.settings.followedPeople.some(
						(person) =>
							person.githubAccountId !== githubAccountId &&
							person.notePath.toLowerCase() ===
								notePath.toLowerCase(),
					)
				)
					return notePathFailed('duplicate');

				const identity: PersonIdentity = {
					username: selected.username,
					githubId: selected.githubAccountId,
				};
				let preparation: NotePreparationResult;
				try {
					preparation =
						await this.dependencies.notes.prepareAssociation(
							notePath,
							identity,
							associationTransform(identity),
						);
				} catch {
					return notePathFailed('internal');
				}
				if (preparation.kind === 'failed')
					return notePathFailed('note');
				const preparedDestination: PreparedNotePathDestination = {
					username: selected.username,
					previousPath: selected.notePath,
					preparedPath: notePath,
				};

				const candidate: DevRadarSettingsV3 = {
					...state.settings,
					followedPeople: state.settings.followedPeople.map(
						(person) =>
							person.githubAccountId === githubAccountId
								? { ...person, notePath }
								: person,
					),
				};
				let saved: SettingsSaveResult;
				try {
					saved =
						await this.dependencies.settings.saveCandidateWithinMutation(
							candidate,
						);
				} catch {
					return notePathFailed('internal', preparedDestination);
				}
				if (saved.kind !== 'saved')
					return notePathFailed(
						saved.kind === 'internal-failure'
							? 'internal'
							: 'persistence',
						preparedDestination,
					);
				return {
					kind: 'updated',
					username: selected.username,
					notePath,
					noteDisposition: preparation.kind,
				};
			});
		} catch {
			return notePathFailed('internal');
		} finally {
			this.pending -= 1;
		}
	}

	private prepareTrackingStart(draft: FollowTrackingStartDraft):
		| {
				readonly ok: true;
				readonly value: FollowedPersonV1['trackingStart'];
		  }
		| {
				readonly ok: false;
				readonly reason: 'invalid-input' | 'internal';
		  } {
		if (!draft || typeof draft !== 'object')
			return { ok: false, reason: 'invalid-input' };
		if (draft.mode === 'available-recent')
			return { ok: true, value: { mode: 'available-recent' } };
		if (draft.mode === 'now') {
			const now = this.currentInstant();
			return now
				? { ok: true, value: { mode: 'from-now', at: now } }
				: { ok: false, reason: 'internal' };
		}
		if (draft.mode !== 'from-date')
			return { ok: false, reason: 'invalid-input' };
		const at = validateCanonicalPluginTimestamp(draft.at);
		if (!at.ok) return { ok: false, reason: 'invalid-input' };
		const now = this.currentInstant();
		if (!now) return { ok: false, reason: 'internal' };
		if (compareCanonicalTimestamps(at.value, now) > 0)
			return { ok: false, reason: 'invalid-input' };
		return { ok: true, value: { mode: 'from-date', at: at.value } };
	}

	private currentInstant(): string | undefined {
		try {
			const result = validateCanonicalPluginTimestamp(
				this.dependencies.now(),
			);
			return result.ok ? result.value : undefined;
		} catch {
			return undefined;
		}
	}
}

function findPerson(
	state: SettingsRuntimeState,
	githubAccountId: string,
): FollowedPersonV1 | undefined {
	return state.kind === 'ready'
		? state.settings.followedPeople.find(
				(person) => person.githubAccountId === githubAccountId,
			)
		: undefined;
}

function unfollowConfirmation(username: string): string {
	return (
		`Unfollow @${username}?\n\n` +
		`This removes @${username} from followed people. Their person note and ` +
		`DevRadar-managed section, including recorded activity, will be preserved. ` +
		`Your user-authored content outside the managed section will also be preserved. ` +
		`No notes will be changed or deleted.`
	);
}
