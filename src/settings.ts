import { PluginSettingTab } from 'obsidian';
export { DEFAULT_SETTINGS, createSettings, type DevRadarSettings } from './settings-data';

export class DevRadarSettingTab extends PluginSettingTab {
	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('p', {
			text: 'There are no configurable settings yet.',
		});
	}
}
