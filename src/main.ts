import { Plugin } from 'obsidian';
import {
	ObsidianSettingsPersistence,
	isResettableSettingsDiagnostic,
	type SettingsLoadResult,
	type SettingsSaveResult,
} from './adapters/obsidian-settings';
import { createEmptySettingsV1 } from './domain/settings';
import { DevRadarSettingTab, type SettingsRuntimeState } from './settings';

export default class DevRadarPlugin extends Plugin {
	private persistence!: ObsidianSettingsPersistence;
	private settingsState!: SettingsRuntimeState;
	private recoveryAction?: Promise<void>;

	async onload(): Promise<void> {
		this.persistence = new ObsidianSettingsPersistence(
			{
				loadData: () => this.loadData(),
				saveData: (data) => this.saveData(data),
			},
			() => new Date().toISOString(),
		);
		this.settingsState = toRuntimeState(await this.persistence.load());
		this.addSettingTab(new DevRadarSettingTab(this.app, this, this));
	}

	getSettingsState(): SettingsRuntimeState {
		return this.settingsState;
	}

	isRecoveryActionPending(): boolean {
		return this.recoveryAction !== undefined;
	}

	async retrySettingsLoad(): Promise<void> {
		await this.runRecoveryAction(async () => {
			this.settingsState = toRuntimeState(await this.persistence.load());
		});
	}

	async resetSettings(): Promise<void> {
		if (
			this.settingsState.kind !== 'recovery' ||
			!isResettableSettingsDiagnostic(this.settingsState.diagnostic)
		)
			return;
		if (!window.confirm(RESET_WARNING)) return;

		await this.runRecoveryAction(async () => {
			const result = await this.persistence.save(createEmptySettingsV1());
			this.settingsState = toRuntimeStateFromSave(result);
		});
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
