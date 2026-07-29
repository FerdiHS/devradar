import { Plugin } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	DevRadarSettingTab,
	type DevRadarSettings,
} from './settings';

export default class DevRadarPlugin extends Plugin {
	settings!: DevRadarSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new DevRadarSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<DevRadarSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
