import { Plugin } from 'obsidian';
import { createSettings, type DevRadarSettings } from './settings-data';

export default class DevRadarPlugin extends Plugin {
	settings!: DevRadarSettings;

	async onload() {
		await this.loadSettings();
	}

	async loadSettings() {
		this.settings = createSettings(
			(await this.loadData()) as Partial<DevRadarSettings>,
		);
	}
}
