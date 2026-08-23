import { normalizePath, Platform, Plugin } from 'obsidian';
import {
	SettingsApplication,
	type SettingsRuntimeState,
} from './application/settings';
import { ObsidianSettingsPersistence } from './adapters/obsidian-settings';
import { DevRadarSettingTab } from './settings';

export default class DevRadarPlugin extends Plugin {
	private persistence!: ObsidianSettingsPersistence;
	private settingsApplication!: SettingsApplication;

	async onload(): Promise<void> {
		this.persistence = new ObsidianSettingsPersistence(
			{
				loadData: () => this.loadData(),
				hasData: () => {
					const pluginDir = this.manifest.dir;
					if (!pluginDir)
						throw new Error('Plugin directory is unavailable');
					return this.app.vault.adapter.exists(
						normalizePath(`${pluginDir}/data.json`),
					);
				},
				saveData: (data) => this.saveData(data),
			},
			() => new Date().toISOString(),
		);
		this.settingsApplication = new SettingsApplication(
			Platform.isMobile ? undefined : this.persistence,
			(message) => window.confirm(message),
		);
		await this.settingsApplication.load();
		this.addSettingTab(
			new DevRadarSettingTab(this.app, this, this.settingsApplication),
		);
	}

	getSettingsState(): SettingsRuntimeState {
		return this.settingsApplication.getSettingsState();
	}

	isRecoveryActionPending(): boolean {
		return this.settingsApplication.isRecoveryActionPending();
	}

	async retrySettingsLoad(): Promise<void> {
		await this.settingsApplication.retrySettingsLoad();
	}

	async resetSettings(): Promise<void> {
		await this.settingsApplication.resetSettings();
	}
}
