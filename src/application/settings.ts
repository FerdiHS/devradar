import {
	createEmptySettingsV2,
	type DevRadarSettingsV2,
	type SchemaV1ValidationError,
} from '../domain/settings';
import type { ActivityFamily } from '../domain/activity';
import type { ApplicationMutationGuard } from './mutation-guard';

export type SettingsRecoveryClassification =
	'ordinary-malformed' | 'future-schema' | 'unclassifiable';

export type SettingsRecoveryDiagnostic =
	| { readonly kind: 'read-failure' }
	| { readonly kind: 'write-failure' }
	| { readonly kind: 'internal-failure' }
	| { readonly kind: 'unsupported-platform' }
	| {
			readonly kind: 'validation';
			readonly classification: SettingsRecoveryClassification;
			readonly error: SchemaV1ValidationError;
	  };

export type SettingsLoadResult =
	| {
			readonly kind: 'loaded';
			readonly settings: DevRadarSettingsV2;
			readonly needsMigration: boolean;
	  }
	| {
			readonly kind: 'recovery';
			readonly diagnostic: SettingsRecoveryDiagnostic;
	  };

export type SettingsSaveResult =
	| { readonly kind: 'saved'; readonly settings: DevRadarSettingsV2 }
	| {
			readonly kind: 'candidate-validation-failure';
			readonly error: SchemaV1ValidationError;
	  }
	| { readonly kind: 'write-failure' }
	| { readonly kind: 'internal-failure' };

export type SettingsPersistence = {
	load(): Promise<SettingsLoadResult>;
	save(candidate: unknown): Promise<SettingsSaveResult>;
};

export type SettingsRuntimeState =
	| { readonly kind: 'ready'; readonly settings: DevRadarSettingsV2 }
	| {
			readonly kind: 'recovery';
			readonly diagnostic: SettingsRecoveryDiagnostic;
	  };

export type SettingsApplicationHost = {
	getSettingsState(): SettingsRuntimeState;
	isRecoveryActionPending(): boolean;
	retrySettingsLoad(): Promise<void>;
	resetSettings(): Promise<void>;
};

export type SettingsAuthority = SettingsApplicationHost & {
	saveCandidate(candidate: DevRadarSettingsV2): Promise<SettingsSaveResult>;
	saveCandidateWithinMutation(
		candidate: DevRadarSettingsV2,
	): Promise<SettingsSaveResult>;
	saveActivityFamilies(
		families: readonly ActivityFamily[],
	): Promise<SettingsSaveResult>;
};

export function isResettableSettingsDiagnostic(
	diagnostic: SettingsRecoveryDiagnostic,
): boolean {
	return (
		diagnostic.kind === 'validation' &&
		diagnostic.classification === 'ordinary-malformed'
	);
}

export class SettingsApplication implements SettingsAuthority {
	private settingsState: SettingsRuntimeState = {
		kind: 'recovery',
		diagnostic: { kind: 'unsupported-platform' },
	};
	private recoveryAction?: Promise<void>;

	constructor(
		private readonly persistence: SettingsPersistence | undefined,
		private readonly confirmReset: (message: string) => boolean,
		private readonly mutationGuard: ApplicationMutationGuard,
	) {}

	async load(): Promise<void> {
		const persistence = this.persistence;
		if (!persistence) return;
		await this.mutationGuard.run(() =>
			this.loadWithinMutation(persistence),
		);
	}

	getSettingsState(): SettingsRuntimeState {
		return this.settingsState;
	}

	async saveCandidate(
		candidate: DevRadarSettingsV2,
	): Promise<SettingsSaveResult> {
		return this.mutationGuard.run(() =>
			this.saveCandidateWithinMutation(candidate),
		);
	}

	async saveCandidateWithinMutation(
		candidate: DevRadarSettingsV2,
	): Promise<SettingsSaveResult> {
		if (!this.persistence) return { kind: 'internal-failure' };
		try {
			const result = await this.persistence.save(candidate);
			this.settingsState = toRuntimeStateFromSave(result);
			return result;
		} catch {
			const result: SettingsSaveResult = { kind: 'internal-failure' };
			this.settingsState = toRuntimeStateFromSave(result);
			return result;
		}
	}

	async saveActivityFamilies(
		families: readonly ActivityFamily[],
	): Promise<SettingsSaveResult> {
		return this.mutationGuard.run(() => {
			if (this.settingsState.kind !== 'ready')
				return Promise.resolve({ kind: 'internal-failure' as const });
			const candidate: DevRadarSettingsV2 = {
				...this.settingsState.settings,
				enabledActivityFamilies: [...families],
			};
			return this.saveCandidateWithinMutation(candidate);
		});
	}

	isRecoveryActionPending(): boolean {
		return this.recoveryAction !== undefined;
	}

	async retrySettingsLoad(): Promise<void> {
		const persistence = this.persistence;
		if (!persistence) return;
		await this.runRecoveryAction(() =>
			this.mutationGuard.run(() => this.loadWithinMutation(persistence)),
		);
	}

	async resetSettings(): Promise<void> {
		if (
			!this.persistence ||
			this.settingsState.kind !== 'recovery' ||
			!isResettableSettingsDiagnostic(this.settingsState.diagnostic)
		)
			return;
		if (!this.confirmReset(RESET_WARNING)) return;
		const persistence = this.persistence;

		await this.runRecoveryAction(() =>
			this.mutationGuard.run(async () => {
				const result = await persistence.save(createEmptySettingsV2());
				this.settingsState = toRuntimeStateFromSave(result);
			}),
		);
	}

	private runRecoveryAction(action: () => Promise<void>): Promise<void> {
		if (this.recoveryAction) return this.recoveryAction;
		const actionPromise = action().finally(() => {
			if (this.recoveryAction === actionPromise)
				this.recoveryAction = undefined;
		});
		this.recoveryAction = actionPromise;
		return actionPromise;
	}

	private async loadWithinMutation(
		persistence: SettingsPersistence,
	): Promise<void> {
		try {
			const result = await persistence.load();
			if (result.kind !== 'loaded') {
				this.settingsState = toRuntimeState(result);
				return;
			}
			if (!result.needsMigration) {
				this.settingsState = toRuntimeState(result);
				return;
			}
			const migrated = await persistence.save(result.settings);
			this.settingsState = toRuntimeStateFromSave(migrated);
		} catch {
			this.settingsState = {
				kind: 'recovery',
				diagnostic: { kind: 'internal-failure' },
			};
		}
	}
}

const RESET_WARNING =
	'DevRadar settings are malformed. Reset them?\n\n' +
	'This will replace the persisted DevRadar settings with a fresh empty value; ' +
	'discard followed-person configuration and synchronization history, deduplication state, ' +
	'and provider-policy state stored in those settings; ' +
	'you will need to follow people again afterward; ' +
	'leave all existing notes untouched; make no GitHub requests; and not delete, rename, ' +
	'move, or overwrite any notes; existing DevRadar activity remains in those notes. ' +
	'Cancel leaves the persisted settings unchanged.';

function toRuntimeState(result: SettingsLoadResult): SettingsRuntimeState {
	return result.kind === 'loaded'
		? { kind: 'ready', settings: result.settings }
		: { kind: 'recovery', diagnostic: result.diagnostic };
}

function toRuntimeStateFromSave(
	result: SettingsSaveResult,
): SettingsRuntimeState {
	if (result.kind === 'saved')
		return { kind: 'ready', settings: result.settings };
	if (result.kind === 'write-failure')
		return { kind: 'recovery', diagnostic: { kind: 'write-failure' } };
	if (result.kind === 'internal-failure')
		return { kind: 'recovery', diagnostic: { kind: 'internal-failure' } };
	return { kind: 'recovery', diagnostic: { kind: 'internal-failure' } };
}
