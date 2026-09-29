import type { DevRadarSettingsV2, FollowedPersonV1 } from '../domain/settings';
import type { ApplicationMutationGuard } from './mutation-guard';
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

type FollowManagementDependencies = {
	readonly settings: Pick<
		SettingsAuthority,
		'getSettingsState' | 'saveCandidateWithinMutation'
	>;
	readonly mutationGuard: ApplicationMutationGuard;
	readonly confirmUnfollow: (message: string) => boolean;
};

const failed = (reason: UnfollowFailureReason): UnfollowResult => ({
	kind: 'failed',
	reason,
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

				const candidate: DevRadarSettingsV2 = {
					...current.settings,
					followedPeople: current.settings.followedPeople
						.filter(
							(item) => item.githubAccountId !== githubAccountId,
						)
						.map(clonePerson),
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

function clonePerson(person: FollowedPersonV1): FollowedPersonV1 {
	return {
		...person,
		trackingStart: { ...person.trackingStart },
		syncState: {
			...person.syncState,
			seenEvents: person.syncState.seenEvents.map((event) => ({
				...event,
			})),
			github: { ...person.syncState.github },
		},
	};
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
