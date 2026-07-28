import { App, PluginSettingTab, Setting } from 'obsidian';
import DevRadarPlugin from './main';

export type DevRadarSettings = Record<string, never>;

export const DEFAULT_SETTINGS: DevRadarSettings = {};

export class DevRadarSettingTab extends PluginSettingTab {
	constructor(app: App, plugin: DevRadarPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('No settings yet')
			.setDesc('There are no configurable settings yet.');
	}
}
