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
	SyncAllApplication,
	type SyncAllFailureReason,
	type SyncAllResult,
} from './application/sync-all';
import { SyncPersonExecutor } from './application/sync-person';
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
import type { ActivityFamily } from './domain/activity';

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
	private syncAllApplication!: SyncAllApplication;
	private syncPending = false;

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
		const syncPersonExecutor = new SyncPersonExecutor({
			settings: this.settingsApplication,
			github,
			notes,
			now: () => new Date().toISOString(),
			isSupportedPlatform: () => !isMobilePlatform(),
		});
		this.syncOneApplication = new SyncOneApplication(
			{
				settings: this.settingsApplication,
				github,
				notes,
				mutationGuard,
				now: () => new Date().toISOString(),
				isSupportedPlatform: () => !isMobilePlatform(),
			},
			syncPersonExecutor,
		);
		this.syncAllApplication = new SyncAllApplication({
			settings: this.settingsApplication,
			executor: syncPersonExecutor,
			mutationGuard,
			now: () => new Date().toISOString(),
			isSupportedPlatform: () => !isMobilePlatform(),
		});
		this.addCommand({
			id: 'sync-one-followed-person',
			name: 'Sync one followed person',
			callback: () => this.startSyncOne(),
		});
		this.addCommand({
			id: 'sync-all-followed-people',
			name: 'Sync all followed people',
			callback: () => this.startSyncAll(),
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

	async saveActivityFamilies(
		families: readonly ActivityFamily[],
	): Promise<import('./application/settings').SettingsSaveResult> {
		return this.settingsApplication.saveActivityFamilies(families);
	}

	isFollowPending(): boolean {
		return this.followApplication.isPending();
	}

	async follow(draft: FollowDraft): Promise<FollowResult> {
		return this.followApplication.follow(draft);
	}

	private startSyncOne(): void {
		if (this.syncPending) {
			new Notice('A sync is already in progress.');
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

		this.syncPending = true;
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
					this.syncPending = false;
				},
			).open();
		} catch {
			this.syncPending = false;
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
			this.syncPending = false;
		}
	}

	private startSyncAll(): void {
		if (this.syncPending) {
			new Notice('A sync is already in progress.');
			return;
		}
		if (isMobilePlatform()) {
			new Notice('Sync all is unavailable on mobile.');
			return;
		}
		const state = this.settingsApplication.getSettingsState();
		if (state.kind !== 'ready') {
			new Notice('Sync all is unavailable until settings are ready.');
			return;
		}
		if (state.settings.followedPeople.length === 0) {
			new Notice('No followed people are available to sync.');
			return;
		}

		this.syncPending = true;
		void this.runSyncAll();
	}

	private async runSyncAll(): Promise<void> {
		try {
			showSyncAllResult(await this.syncAllApplication.syncAll());
		} catch {
			new Notice('Sync all failed unexpectedly.');
		} finally {
			this.syncPending = false;
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

function showSyncAllResult(result: SyncAllResult): void {
	if (result.kind === 'empty') {
		new Notice('No followed people are available to sync.');
		return;
	}
	if (result.kind === 'failed') {
		new Notice(syncAllRunFailureMessage(result.reason));
		return;
	}

	const counts = {
		updated: 0,
		unchanged: 0,
		skipped:
			result.stop?.kind === 'provider-policy' ? result.stop.skipped : 0,
		failed: 0,
	};
	const failures: string[] = [];
	for (const outcome of result.outcomes) {
		if (outcome.result.kind === 'failed') {
			counts.failed += 1;
			failures.push(
				`@${outcome.username} (${syncFailureDescription(outcome.result.reason)})`,
			);
		} else if (outcome.result.kind === 'skipped') {
			counts.skipped += 1;
		} else {
			counts[outcome.result.kind] += 1;
		}
	}

	const parts = [
		`Sync all finished: ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.skipped} skipped, ${counts.failed} failed.`,
	];
	if (failures.length > 0) parts.push(`Failures: ${failures.join('; ')}.`);
	if (result.stop?.kind === 'provider-policy' && result.stop.skipped > 0)
		parts.push(
			`${result.stop.skipped} remaining people were skipped because a GitHub provider policy is active.`,
		);
	if (
		result.stop?.kind === 'settings-recovery' &&
		result.stop.unattempted > 0
	)
		parts.push(
			`${result.stop.unattempted} people were not attempted because settings need recovery.`,
		);
	if (result.stop?.kind === 'run-failure' && result.stop.unattempted > 0)
		parts.push(
			`${result.stop.unattempted} people were not attempted because sync stopped: ${syncAllRunFailureMessage(result.stop.reason)}`,
		);
	new Notice(parts.join(' '));
}

function syncAllRunFailureMessage(reason: SyncAllFailureReason): string {
	const messages: Record<SyncAllFailureReason, string> = {
		'unsupported-platform': 'Sync all is unavailable on mobile.',
		'settings-not-ready':
			'Sync all is unavailable until settings are ready.',
		configuration: 'Sync all could not use the current configuration.',
		internal: 'Sync all failed unexpectedly.',
	};
	return messages[reason];
}

function syncFailureDescription(reason: SyncOneFailureReason): string {
	const descriptions: Record<SyncOneFailureReason, string> = {
		'settings-not-ready': 'settings are not ready',
		'unsupported-platform': 'unavailable on mobile',
		'invalid-selection': 'person selection was invalid',
		configuration: 'configuration was invalid',
		provider: 'GitHub retrieval failed',
		note: 'the associated note could not be updated',
		persistence: 'sync state could not be saved',
		internal: 'unexpected error',
	};
	return descriptions[reason];
}
