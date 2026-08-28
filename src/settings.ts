import { App, PluginSettingTab, type Plugin } from 'obsidian';
import {
	isResettableSettingsDiagnostic,
	type SettingsApplicationHost,
	type SettingsRecoveryClassification,
	type SettingsRecoveryDiagnostic,
} from './application/settings';
import type {
	FollowDraft,
	FollowResult,
	FollowTrackingStartDraft,
} from './application/follow';

export type { SettingsRuntimeState } from './application/settings';

export type SettingsTabHost = SettingsApplicationHost & {
	isFollowPending(): boolean;
	follow(draft: FollowDraft): Promise<FollowResult>;
};

type TrackingStartMode = FollowTrackingStartDraft['mode'];

export class DevRadarSettingTab extends PluginSettingTab {
	private username = '';
	private notePath = '';
	private trackingStartMode: TrackingStartMode = 'now';
	private fromDate = '';
	private followPending = false;
	private followStatus?: string;

	constructor(
		app: App,
		plugin: Plugin,
		private readonly host: SettingsTabHost,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const state = this.host.getSettingsState();
		if (state.kind === 'ready') {
			this.displayReady(containerEl, state.settings.followedPeople);
			return;
		}

		const diagnostic = state.diagnostic;
		containerEl.createEl('p', {
			text: 'Settings need attention.',
		});
		containerEl.createEl('p', {
			text: 'Settings-dependent configuration and synchronization are disabled until recovery succeeds. Existing notes remain untouched.',
		});
		containerEl.createEl('p', { text: diagnosticText(diagnostic) });

		const pending = this.host.isRecoveryActionPending();
		if (diagnostic.kind === 'unsupported-platform') return;
		const retry = containerEl.createEl('button', { text: 'Retry' });
		retry.disabled = pending;
		retry.addEventListener('click', () => {
			this.rerenderAfterAction(this.host.retrySettingsLoad());
		});

		if (isResettableSettingsDiagnostic(diagnostic)) {
			const reset = containerEl.createEl('button', { text: 'Reset' });
			reset.disabled = pending;
			reset.addEventListener('click', () => {
				this.rerenderAfterAction(this.host.resetSettings());
			});
		}
	}

	private displayReady(
		containerEl: HTMLElement,
		followedPeople: readonly {
			username: string;
			notePath: string;
			trackingStart: {
				mode: 'from-now' | 'available-recent' | 'from-date';
				at?: string;
			};
		}[],
	): void {
		containerEl.createEl('p', { text: 'Follow a GitHub user' });
		containerEl.createEl('label', { text: 'GitHub username' });
		const username = containerEl.createEl('input');
		username.type = 'text';
		username.value = this.username;
		username.addEventListener('input', () => {
			this.username = username.value;
		});

		containerEl.createEl('label', { text: 'Note destination' });
		const notePath = containerEl.createEl('input');
		notePath.type = 'text';
		notePath.value = this.notePath;
		notePath.placeholder = 'People/octocat.md';
		notePath.addEventListener('input', () => {
			this.notePath = notePath.value;
		});

		containerEl.createEl('label', { text: 'Tracking start' });
		const trackingStart = containerEl.createEl('select');
		for (const option of [
			['now', 'Now'],
			['available-recent', 'Available recent activity'],
			['from-date', 'Date & time'],
		] as const) {
			const element = trackingStart.createEl('option', {
				text: option[1],
			});
			element.value = option[0];
		}
		trackingStart.value = this.trackingStartMode;
		trackingStart.addEventListener('change', () => {
			this.trackingStartMode = trackingStart.value as TrackingStartMode;
			this.display();
		});

		if (this.trackingStartMode === 'from-date') {
			containerEl.createEl('label', { text: 'Date & time' });
			const fromDate = containerEl.createEl('input');
			fromDate.type = 'datetime-local';
			fromDate.step = '60';
			fromDate.value = this.fromDate;
			fromDate.addEventListener('input', () => {
				this.fromDate = fromDate.value;
			});
		}

		const follow = containerEl.createEl('button', { text: 'Follow' });
		const pending = this.followPending || this.host.isFollowPending();
		follow.disabled = pending;
		follow.addEventListener('click', () => {
			if (this.followPending || this.host.isFollowPending()) return;
			this.followPending = true;
			this.followStatus = undefined;
			this.display();
			void this.host.follow(this.draft()).then(
				(result) => this.finishFollow(result),
				() => this.finishFollow({ kind: 'failed', reason: 'internal' }),
			);
		});

		if (this.followStatus !== undefined)
			containerEl.createEl('p', { text: this.followStatus });

		containerEl.createEl('p', { text: 'Followed people' });
		if (followedPeople.length === 0) {
			containerEl.createEl('p', { text: 'No followed people yet.' });
			return;
		}
		const list = containerEl.createEl('ul');
		for (const person of followedPeople) {
			list.createEl('li', {
				text: `@${person.username} — ${person.notePath} — ${trackingStartSummary(person.trackingStart)}`,
			});
		}
	}

	private draft(): FollowDraft {
		if (this.trackingStartMode === 'from-date')
			return {
				username: this.username,
				notePath: this.notePath,
				trackingStart: {
					mode: 'from-date',
					at: localDateTimeToUtc(this.fromDate) ?? '',
				},
			};
		return {
			username: this.username,
			notePath: this.notePath,
			trackingStart: { mode: this.trackingStartMode },
		};
	}

	private finishFollow(result: FollowResult): void {
		this.followPending = false;
		this.followStatus = followStatus(result);
		this.display();
	}

	private rerenderAfterAction(action: Promise<void>): void {
		this.display();
		void action.then(
			() => this.display(),
			() => this.display(),
		);
	}
}

function localDateTimeToUtc(value: string): string | undefined {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
	const [date, time] = value.split('T');
	const [year, month, day] = date?.split('-').map(Number) ?? [];
	const [hour, minute] = time?.split(':').map(Number) ?? [];
	if (![year, month, day, hour, minute].every(Number.isFinite))
		return undefined;
	const local = new Date(year ?? 0, (month ?? 0) - 1, day, hour, minute);
	if (
		Number.isNaN(local.getTime()) ||
		local.getFullYear() !== year ||
		local.getMonth() !== (month ?? 0) - 1 ||
		local.getDate() !== day ||
		local.getHours() !== hour ||
		local.getMinutes() !== minute
	)
		return undefined;
	return local.toISOString();
}

function trackingStartSummary(start: {
	readonly mode: 'from-now' | 'available-recent' | 'from-date';
	readonly at?: string;
}): string {
	if (start.mode === 'from-now') return 'Now';
	if (start.mode === 'available-recent') return 'Available recent activity';
	return `Date & time: ${start.at ?? 'invalid'}`;
}

function followStatus(result: FollowResult): string {
	if (result.kind === 'followed')
		return `Followed @${result.person.username} (${result.noteDisposition}).`;
	if (result.kind === 'skipped')
		return 'Follow skipped because GitHub requests are temporarily unavailable.';
	switch (result.reason) {
		case 'invalid-input':
			return 'Follow could not start because the input is invalid.';
		case 'settings-not-ready':
			return 'Follow is unavailable until settings recovery succeeds.';
		case 'identity':
			return 'GitHub identity could not be resolved.';
		case 'duplicate':
			return 'That person or note destination is already followed.';
		case 'note':
			return 'The note could not be prepared safely.';
		case 'persistence':
			return 'DevRadar could not save the follow settings.';
		case 'internal':
			return 'DevRadar could not complete Follow safely.';
	}
}

function diagnosticText(diagnostic: SettingsRecoveryDiagnostic): string {
	switch (diagnostic.kind) {
		case 'read-failure':
			return 'DevRadar could not read its saved settings. Retry to try again.';
		case 'write-failure':
			return 'DevRadar could not save its settings. Retry to reload them.';
		case 'internal-failure':
			return 'DevRadar could not safely process its settings. Retry to try again.';
		case 'unsupported-platform':
			return 'DevRadar settings persistence is not enabled on Obsidian Mobile until its runtime contract is validated. Use Obsidian Desktop for now.';
		case 'validation':
			return validationText(diagnostic.classification, diagnostic.error);
	}
}

function validationText(
	classification: SettingsRecoveryClassification,
	error: { code: string; path: string; message: string },
): string {
	if (classification === 'future-schema')
		return 'These settings were created by a newer DevRadar data format. Update DevRadar, or deliberately restore compatible plugin data, then Retry.';
	if (classification === 'unclassifiable')
		return 'DevRadar settings could not be safely classified. Retry to try again.';
	return `DevRadar settings are invalid (${error.code} at ${error.path}): ${error.message}`;
}
