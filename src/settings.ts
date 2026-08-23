import { App, PluginSettingTab, type Plugin } from 'obsidian';
import {
	isResettableSettingsDiagnostic,
	type SettingsRecoveryClassification,
	type SettingsRecoveryDiagnostic,
} from './adapters/obsidian-settings';
import type { DevRadarSettingsV1 } from './domain/settings';

export type SettingsRuntimeState =
	| { readonly kind: 'ready'; readonly settings: DevRadarSettingsV1 }
	| {
			readonly kind: 'recovery';
			readonly diagnostic: SettingsRecoveryDiagnostic;
	  };

export type SettingsTabHost = {
	getSettingsState(): SettingsRuntimeState;
	isRecoveryActionPending(): boolean;
	retrySettingsLoad(): Promise<void>;
	resetSettings(): Promise<void>;
};

export class DevRadarSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		plugin: Plugin,
		private readonly host: SettingsTabHost,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const state = this.host.getSettingsState();
		if (state.kind === 'ready') {
			containerEl.createEl('p', {
				text: 'There are no configurable settings yet.',
			});
			return;
		}

		const diagnostic = state.diagnostic;
		containerEl.createEl('p', {
			text: 'Settings need attention for DevRadar.',
		});
		containerEl.createEl('p', {
			text: 'Settings-dependent configuration and synchronization are disabled until recovery succeeds. Existing notes remain untouched.',
		});
		containerEl.createEl('p', { text: diagnosticText(diagnostic) });

		const pending = this.host.isRecoveryActionPending();
		const retry = containerEl.createEl('button', { text: 'Retry' });
		retry.disabled = pending;
		retry.addEventListener('click', () => {
			void this.host.retrySettingsLoad().then(() => this.display());
		});

		if (isResettableSettingsDiagnostic(diagnostic)) {
			const reset = containerEl.createEl('button', { text: 'Reset' });
			reset.disabled = pending;
			reset.addEventListener('click', () => {
				if (!window.confirm(RESET_WARNING)) return;
				void this.host.resetSettings().then(() => this.display());
			});
		}
	}
}

const RESET_WARNING =
	'DevRadar settings are malformed. Reset them?\n\n' +
	'This will replace the persisted DevRadar settings with a fresh empty value; ' +
	'discard followed-person configuration and sync history stored in those settings; ' +
	'you will need to follow people again afterward; ' +
	'leave all existing notes untouched; make no GitHub requests; and not delete, rename, ' +
	'move, or overwrite any notes. Cancel leaves the persisted settings unchanged.';

function diagnosticText(diagnostic: SettingsRecoveryDiagnostic): string {
	switch (diagnostic.kind) {
		case 'read-failure':
			return 'DevRadar could not read its saved settings. Retry to try again.';
		case 'write-failure':
			return 'DevRadar could not save its settings. Retry to reload them.';
		case 'internal-failure':
			return 'DevRadar could not safely process its settings. Retry to try again.';
		case 'validation':
			return validationText(diagnostic.classification, diagnostic.error);
	}
}

function validationText(
	classification: SettingsRecoveryClassification,
	error: { code: string; path: string; message: string },
): string {
	if (classification === 'future-schema')
		return 'DevRadar settings use a newer schema version and cannot be loaded by this plugin.';
	if (classification === 'unclassifiable')
		return 'DevRadar settings could not be safely classified. Retry to try again.';
	return `DevRadar settings are invalid (${error.code} at ${error.path}): ${error.message}`;
}
