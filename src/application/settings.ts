import {
	createEmptySettingsV1,
	type DevRadarSettingsV1,
	type SchemaV1ValidationError,
} from '../domain/settings';
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
	| { readonly kind: 'loaded'; readonly settings: DevRadarSettingsV1 }
	| {
			readonly kind: 'recovery';
			readonly diagnostic: SettingsRecoveryDiagnostic;
	  };

export type SettingsSaveResult =
	| { readonly kind: 'saved'; readonly settings: DevRadarSettingsV1 }
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
	| { readonly kind: 'ready'; readonly settings: DevRadarSettingsV1 }
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
	saveCandidate(candidate: DevRadarSettingsV1): Promise<SettingsSaveResult>;
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
		this.settingsState = toRuntimeState(await persistence.load());
	}

	getSettingsState(): SettingsRuntimeState {
		return this.settingsState;
	}

	async saveCandidate(
		candidate: DevRadarSettingsV1,
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

	isRecoveryActionPending(): boolean {
		return this.recoveryAction !== undefined;
	}

	async retrySettingsLoad(): Promise<void> {
		const persistence = this.persistence;
		if (!persistence) return;
		await this.runRecoveryAction(() =>
			this.mutationGuard.run(async () => {
				this.settingsState = toRuntimeState(await persistence.load());
			}),
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
				const result = await persistence.save(createEmptySettingsV1());
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
