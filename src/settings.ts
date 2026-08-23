import { App, PluginSettingTab, type Plugin } from 'obsidian';
import {
	isResettableSettingsDiagnostic,
	type SettingsApplicationHost,
	type SettingsRecoveryClassification,
	type SettingsRecoveryDiagnostic,
} from './application/settings';
import type { SettingsRuntimeState } from './application/settings';

export type { SettingsRuntimeState } from './application/settings';

export type SettingsTabHost = SettingsApplicationHost;

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
			text: 'Settings need attention.',
		});
		containerEl.createEl('p', {
			text: 'Settings-dependent configuration and synchronization are disabled until recovery succeeds. Existing notes remain untouched.',
		});
		containerEl.createEl('p', { text: diagnosticText(diagnostic) });

		const pending = this.host.isRecoveryActionPending();
		if (diagnostic.kind === 'unsupported-platform') return;
		const retry = containerEl.createEl('button', { text: 'Retry' });
		retry.disabled = pending;
		retry.addEventListener('click', () => {
			this.rerenderAfterAction(this.host.retrySettingsLoad());
		});

		if (isResettableSettingsDiagnostic(diagnostic)) {
			const reset = containerEl.createEl('button', { text: 'Reset' });
			reset.disabled = pending;
			reset.addEventListener('click', () => {
				this.rerenderAfterAction(this.host.resetSettings());
			});
		}
	}

	private rerenderAfterAction(action: Promise<void>): void {
		this.display();
		void action.then(
			() => this.display(),
			() => this.display(),
		);
	}
}

function diagnosticText(diagnostic: SettingsRecoveryDiagnostic): string {
	switch (diagnostic.kind) {
		case 'read-failure':
			return 'DevRadar could not read its saved settings. Retry to try again.';
		case 'write-failure':
			return 'DevRadar could not save its settings. Retry to reload them.';
		case 'internal-failure':
			return 'DevRadar could not safely process its settings. Retry to try again.';
		case 'unsupported-platform':
			return 'DevRadar settings persistence is not enabled on Obsidian Mobile until its runtime contract is validated. Use Obsidian Desktop for now.';
		case 'validation':
			return validationText(diagnostic.classification, diagnostic.error);
	}
}

function validationText(
	classification: SettingsRecoveryClassification,
	error: { code: string; path: string; message: string },
): string {
	if (classification === 'future-schema')
		return 'These settings were created by a newer DevRadar data format. Update DevRadar, or deliberately restore compatible plugin data, then Retry.';
	if (classification === 'unclassifiable')
		return 'DevRadar settings could not be safely classified. Retry to try again.';
	return `DevRadar settings are invalid (${error.code} at ${error.path}): ${error.message}`;
}
