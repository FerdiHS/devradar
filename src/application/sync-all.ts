import { compareCanonicalTimestamps } from '../domain/activity';
import {
	validateCanonicalPluginTimestamp,
	validatePersistedSettingsV2,
	type CanonicalPluginTimestamp,
	type DevRadarSettingsV2,
} from '../domain/settings';
import type { ApplicationMutationGuard } from './mutation-guard';
import type { SettingsAuthority, SettingsRuntimeState } from './settings';
import type { SyncOneResult } from './sync-one';
import type { SyncPersonExecutor } from './sync-person';

export type SyncAllFailureReason =
	| 'unsupported-platform'
	| 'settings-not-ready'
	| 'configuration'
	| 'internal';

export type SyncAllPersonOutcome = Readonly<{
	username: string;
	result: SyncOneResult;
}>;

export type SyncAllStop =
	| Readonly<{ kind: 'provider-policy'; skipped: number }>
	| Readonly<{ kind: 'provider-rate-limit'; skipped: number }>
	| Readonly<{ kind: 'provider-incompatibility'; skipped: number }>
	| Readonly<{ kind: 'settings-recovery'; unattempted: number }>
	| Readonly<{
			kind: 'run-failure';
			reason: SyncAllFailureReason;
			unattempted: number;
	  }>;

export type SyncAllResult =
	| Readonly<{ kind: 'empty' }>
	| Readonly<{ kind: 'failed'; reason: SyncAllFailureReason }>
	| Readonly<{
			kind: 'completed';
			outcomes: readonly SyncAllPersonOutcome[];
			stop?: SyncAllStop;
	  }>;

export type SyncAllDependencies = {
	readonly settings: Pick<SettingsAuthority, 'getSettingsState'>;
	readonly executor: Pick<SyncPersonExecutor, 'execute'>;
	readonly mutationGuard: ApplicationMutationGuard;
	readonly now: () => string;
	readonly isSupportedPlatform: () => boolean;
};

type ReadySettingsSnapshot = {
	readonly kind: 'ready';
	readonly settings: DevRadarSettingsV2;
	readonly now: CanonicalPluginTimestamp;
};
type SettingsRead =
	| ReadySettingsSnapshot
	| { readonly kind: 'not-ready' }
	| { readonly kind: 'invalid' };

export class SyncAllApplication {
	constructor(private readonly dependencies: SyncAllDependencies) {}

	async syncAll(): Promise<SyncAllResult> {
		try {
			return await this.dependencies.mutationGuard.run(() =>
				this.execute(),
			);
		} catch {
			return { kind: 'failed', reason: 'internal' };
		}
	}

	private async execute(): Promise<SyncAllResult> {
		if (!this.dependencies.isSupportedPlatform())
			return { kind: 'failed', reason: 'unsupported-platform' };

		const runStartedAt = this.currentInstant();
		if (!runStartedAt) return { kind: 'failed', reason: 'internal' };
		const initial = this.readSettings(runStartedAt);
		if (initial.kind === 'not-ready')
			return { kind: 'failed', reason: 'settings-not-ready' };
		if (initial.kind === 'invalid')
			return { kind: 'failed', reason: 'configuration' };
		if (initial.settings.followedPeople.length === 0)
			return { kind: 'empty' };

		const accountIds = initial.settings.followedPeople.map(
			(person) => person.githubAccountId,
		);
		const outcomes: SyncAllPersonOutcome[] = [];
		for (let index = 0; index < accountIds.length; index += 1) {
			const accountId = accountIds[index];
			if (accountId === undefined)
				return this.stopForRunFailure(
					outcomes,
					'configuration',
					accountIds.length - index,
				);

			const before = this.readCurrentSettingsSafely();
			if (before.kind === 'error')
				return this.stopForRunFailure(
					outcomes,
					'internal',
					accountIds.length - index,
				);
			if (before.kind === 'not-ready') {
				if (outcomes.length === 0)
					return { kind: 'failed', reason: 'settings-not-ready' };
				return {
					kind: 'completed',
					outcomes,
					stop: {
						kind: 'settings-recovery',
						unattempted: accountIds.length - index,
					},
				};
			}
			if (before.kind === 'invalid')
				return this.stopForRunFailure(
					outcomes,
					'configuration',
					accountIds.length - index,
				);

			const person = before.settings.followedPeople.find(
				(candidate) => candidate.githubAccountId === accountId,
			);
			if (!person)
				return this.stopForRunFailure(
					outcomes,
					'configuration',
					accountIds.length - index,
				);

			let execution: Awaited<ReturnType<SyncPersonExecutor['execute']>>;
			try {
				execution = await this.dependencies.executor.execute({
					githubAccountId: accountId,
				});
			} catch {
				const result: SyncOneResult = {
					kind: 'failed',
					reason: 'internal',
				};
				outcomes.push({ username: person.username, result });
				return this.stopForRunFailure(
					outcomes,
					'internal',
					accountIds.length - index - 1,
				);
			}
			const { result } = execution;
			outcomes.push({ username: person.username, result });

			const after = this.readCurrentSettingsSafely();
			if (after.kind === 'error')
				return this.stopForRunFailure(
					outcomes,
					'internal',
					accountIds.length - index - 1,
				);
			if (result.kind === 'failed' && result.reason === 'persistence') {
				return {
					kind: 'completed',
					outcomes,
					stop: {
						kind: 'settings-recovery',
						unattempted: accountIds.length - index - 1,
					},
				};
			}
			if (after.kind === 'not-ready')
				return {
					kind: 'completed',
					outcomes,
					stop: {
						kind: 'settings-recovery',
						unattempted: accountIds.length - index - 1,
					},
				};
			if (after.kind === 'invalid')
				return this.stopForRunFailure(
					outcomes,
					'configuration',
					accountIds.length - index - 1,
				);
			if (!execution.safeToContinue)
				return this.stopForRunFailure(
					outcomes,
					'internal',
					accountIds.length - index - 1,
				);

			const skipped = accountIds.length - index - 1;
			if (
				skipped > 0 &&
				isGlobalPolicyActive(after.settings, after.now)
			) {
				return {
					kind: 'completed',
					outcomes,
					stop: {
						kind: 'provider-policy',
						skipped,
					},
				};
			}
			if (skipped > 0 && execution.providerWideStop) {
				return {
					kind: 'completed',
					outcomes,
					stop: {
						kind:
							execution.providerWideStop === 'rate-limit'
								? 'provider-rate-limit'
								: 'provider-incompatibility',
						skipped,
					},
				};
			}
		}

		return { kind: 'completed', outcomes };
	}

	private readCurrentSettings(): SettingsRead {
		const now = this.currentInstant();
		if (!now) return { kind: 'invalid' };
		return this.readSettings(now);
	}

	private readCurrentSettingsSafely():
		SettingsRead | { readonly kind: 'error' } {
		try {
			return this.readCurrentSettings();
		} catch {
			return { kind: 'error' };
		}
	}

	private readSettings(now: CanonicalPluginTimestamp): SettingsRead {
		const runtime: SettingsRuntimeState =
			this.dependencies.settings.getSettingsState();
		if (runtime.kind !== 'ready') return { kind: 'not-ready' };
		const validated = validatePersistedSettingsV2(runtime.settings, now);
		return validated.ok
			? { kind: 'ready', settings: validated.value, now }
			: { kind: 'invalid' };
	}

	private currentInstant(): CanonicalPluginTimestamp | undefined {
		const validated = validateCanonicalPluginTimestamp(
			this.dependencies.now(),
		);
		return validated.ok ? validated.value : undefined;
	}

	private stopForRunFailure(
		outcomes: readonly SyncAllPersonOutcome[],
		reason: SyncAllFailureReason,
		unattempted: number,
	): SyncAllResult {
		return outcomes.length === 0
			? { kind: 'failed', reason }
			: {
					kind: 'completed',
					outcomes,
					stop: { kind: 'run-failure', reason, unattempted },
				};
	}
}

function isGlobalPolicyActive(
	settings: DevRadarSettingsV2,
	now: CanonicalPluginTimestamp,
): boolean {
	const boundary = settings.githubRequestPolicy?.rateLimitNotBefore;
	return (
		boundary !== undefined && compareCanonicalTimestamps(boundary, now) > 0
	);
}
