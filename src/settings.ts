import { App, PluginSettingTab, Setting } from 'obsidian';
import DevRadarPlugin from './main';

export interface DevRadarSettings {
	mySetting: string;
}

export const DEFAULT_SETTINGS: DevRadarSettings = {
	mySetting: 'default',
};

export class DevRadarSettingTab extends PluginSettingTab {
	plugin: DevRadarPlugin;

	constructor(app: App, plugin: DevRadarPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Settings #1')
			.setDesc("It's a secret")
			.addText((text) =>
				text
					.setPlaceholder('Enter your secret')
					.setValue(this.plugin.settings.mySetting)
					.onChange(async (value) => {
						this.plugin.settings.mySetting = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
