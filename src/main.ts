import { Plugin } from 'obsidian';
import { DevRadarSettingTab } from './settings';
import { createSettings, type DevRadarSettings } from './settings-data';

export default class DevRadarPlugin extends Plugin {
	settings!: DevRadarSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new DevRadarSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = createSettings(
			(await this.loadData()) as Partial<DevRadarSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
