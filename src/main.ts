import { normalizePath, Platform, Plugin } from 'obsidian';
import {
	SettingsApplication,
	type SettingsRuntimeState,
} from './application/settings';
import { createApplicationMutationGuard } from './application/mutation-guard';
import {
	FollowApplication,
	type FollowDraft,
	type FollowResult,
} from './application/follow';
import { GitHubAdapter } from './adapters/github';
import { createObsidianGitHubTransport } from './adapters/github-transport';
import { createObsidianNotePersistence } from './adapters/obsidian-notes';
import { ObsidianSettingsPersistence } from './adapters/obsidian-settings';
import { DevRadarSettingTab } from './settings';

export default class DevRadarPlugin extends Plugin {
	private persistence!: ObsidianSettingsPersistence;
	private settingsApplication!: SettingsApplication;
	private followApplication!: FollowApplication;

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
		const mutationGuard = createApplicationMutationGuard();
		this.settingsApplication = new SettingsApplication(
			Platform.isMobile ? undefined : this.persistence,
			(message) => window.confirm(message),
			mutationGuard,
		);
		await this.settingsApplication.load();
		this.followApplication = new FollowApplication({
			settings: this.settingsApplication,
			github: new GitHubAdapter({
				pluginVersion: this.manifest.version,
				transport: createObsidianGitHubTransport(this.manifest.version),
			}),
			notes: createObsidianNotePersistence(this.app.vault),
			mutationGuard,
			now: () => new Date().toISOString(),
		});
		this.addSettingTab(new DevRadarSettingTab(this.app, this, this));
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

	isFollowPending(): boolean {
		return this.followApplication.isPending();
	}

	async follow(draft: FollowDraft): Promise<FollowResult> {
		return this.followApplication.follow(draft);
	}
}
