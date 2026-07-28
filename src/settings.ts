import { PluginSettingTab } from 'obsidian';

export type DevRadarSettings = Record<string, never>;

export const DEFAULT_SETTINGS: DevRadarSettings = {};

export class DevRadarSettingTab extends PluginSettingTab {
	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('p', {
			text: 'There are no configurable settings yet.',
		});
	}
}
