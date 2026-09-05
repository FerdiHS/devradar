import {
	FuzzySuggestModal,
	normalizePath,
	Notice,
	Platform,
	Plugin,
	type App,
} from 'obsidian';
import {
	SettingsApplication,
	type SettingsRuntimeState,
} from './application/settings';
import { createApplicationMutationGuard } from './application/mutation-guard';
import {
	SyncOneApplication,
	type SyncOneFailureReason,
	type SyncOneResult,
} from './application/sync-one';
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

type SyncOnePickerItem = Readonly<{
	username: string;
	githubAccountId: string;
}>;

class SyncOnePicker extends FuzzySuggestModal<SyncOnePickerItem> {
	private selected = false;

	constructor(
		app: App,
		private readonly items: readonly SyncOnePickerItem[],
		private readonly onPick: (item: SyncOnePickerItem) => void,
		private readonly onCancel: () => void,
	) {
		super(app);
	}

	getItems(): SyncOnePickerItem[] {
		return [...this.items];
	}

	getItemText(item: SyncOnePickerItem): string {
		return `@${item.username}`;
	}

	onChooseItem(item: SyncOnePickerItem): void {
		this.selected = true;
		this.onPick({
			githubAccountId: item.githubAccountId,
			username: item.username,
		});
	}

	onClose(): void {
		queueMicrotask(() => {
			if (!this.selected) this.onCancel();
		});
	}
}

export default class DevRadarPlugin extends Plugin {
	private persistence!: ObsidianSettingsPersistence;
	private settingsApplication!: SettingsApplication;
	private followApplication!: FollowApplication;
	private syncOneApplication!: SyncOneApplication;
	private syncOnePending = false;

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
		const github = new GitHubAdapter({
			pluginVersion: this.manifest.version,
			transport: createObsidianGitHubTransport(this.manifest.version),
		});
		const notes = createObsidianNotePersistence(
			this.app.vault,
			this.app.fileManager,
		);
		this.followApplication = new FollowApplication({
			settings: this.settingsApplication,
			github,
			notes,
			mutationGuard,
			now: () => new Date().toISOString(),
		});
		this.syncOneApplication = new SyncOneApplication({
			settings: this.settingsApplication,
			github,
			notes,
			mutationGuard,
			now: () => new Date().toISOString(),
			isSupportedPlatform: () => !isMobilePlatform(),
		});
		this.addCommand({
			id: 'sync-one-followed-person',
			name: 'Sync one followed person',
			callback: () => this.startSyncOne(),
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

	private startSyncOne(): void {
		if (this.syncOnePending) {
			new Notice('Sync one is already in progress.');
			return;
		}
		if (isMobilePlatform()) {
			new Notice('Sync one is unavailable on mobile.');
			return;
		}
		const state = this.settingsApplication.getSettingsState();
		if (state.kind !== 'ready') {
			new Notice('Sync one is unavailable until settings are ready.');
			return;
		}
		if (state.settings.followedPeople.length === 0) {
			new Notice('No followed people are available to sync.');
			return;
		}

		this.syncOnePending = true;
		const items = state.settings.followedPeople.map((person) => ({
			username: person.username,
			githubAccountId: person.githubAccountId,
		}));
		try {
			new SyncOnePicker(
				this.app,
				items,
				(item) => {
					void this.runSyncOne({
						githubAccountId: item.githubAccountId,
					});
				},
				() => {
					this.syncOnePending = false;
				},
			).open();
		} catch {
			this.syncOnePending = false;
			new Notice('Sync one failed unexpectedly.');
		}
	}

	private async runSyncOne(selection: {
		readonly githubAccountId: string;
	}): Promise<void> {
		try {
			const result = await this.syncOneApplication.syncOne(selection);
			showSyncOneResult(result);
		} catch {
			new Notice('Sync one failed unexpectedly.');
		} finally {
			this.syncOnePending = false;
		}
	}
}

function isMobilePlatform(): boolean {
	return Platform.isMobileApp;
}

function showSyncOneResult(result: SyncOneResult): void {
	if (result.kind === 'updated') {
		new Notice("Sync one updated the person's note.");
		return;
	}
	if (result.kind === 'unchanged') {
		new Notice('Sync one found no changes.');
		return;
	}
	if (result.kind === 'skipped') {
		new Notice('Sync one skipped: GitHub policy is active.');
		return;
	}
	const messages: Record<SyncOneFailureReason, string> = {
		'settings-not-ready':
			'Sync one is unavailable until settings are ready.',
		'unsupported-platform': 'Sync one is unavailable on mobile.',
		'invalid-selection': 'Sync one could not find the selected person.',
		configuration: 'Sync one could not use the current configuration.',
		provider: 'Sync one could not retrieve GitHub activity.',
		note: 'Sync one could not update the associated note.',
		persistence: 'Sync one could not save synchronization state.',
		internal: 'Sync one failed unexpectedly.',
	};
	new Notice(messages[result.reason]);
}
