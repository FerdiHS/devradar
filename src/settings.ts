import {
	App,
	PluginSettingTab,
	requireApiVersion,
	type Plugin,
	type SettingDefinition,
	type SettingDefinitionItem,
} from 'obsidian';
import { ACTIVITY_FAMILIES, type ActivityFamily } from './domain/activity';
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
	saveActivityFamilies(
		families: readonly ActivityFamily[],
	): Promise<import('./application/settings').SettingsSaveResult>;
};

type TrackingStartMode = FollowTrackingStartDraft['mode'];
type SettingsRefresh = () => void;
type ReadySettings = Extract<
	ReturnType<SettingsTabHost['getSettingsState']>,
	{ kind: 'ready' }
>['settings'];
type FollowedPersonSummary = {
	readonly username: string;
	readonly notePath: string;
	readonly trackingStart: {
		readonly mode: 'from-now' | 'available-recent' | 'from-date';
		readonly at?: string;
	};
};

export class DevRadarSettingTab extends PluginSettingTab {
	private username = '';
	private notePath = '';
	private trackingStartMode: TrackingStartMode = 'now';
	private fromDate = '';
	private fromTime = '';
	private fromTimeBadInput = false;
	private followPending = false;
	private followStatus?: string;
	private activityFamiliesDraft?: ActivityFamily[];
	private activitySavePending = false;
	private activitySaveStatus?: string;

	constructor(
		app: App,
		plugin: Plugin,
		private readonly host: SettingsTabHost,
	) {
		super(app, plugin);
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		const state = this.host.getSettingsState();
		const refresh = () => this.updateDeclarativeSettings();
		if (state.kind !== 'ready')
			return this.recoveryDefinitions(state.diagnostic, refresh);
		return this.readyDefinitions(state.settings, refresh);
	}

	private updateDeclarativeSettings(): void {
		if (requireApiVersion('1.13.0')) this.update();
	}

	private refreshDeclarativeDomState(): void {
		if (requireApiVersion('1.13.0')) this.refreshDomState();
	}

	private recoveryDefinitions(
		diagnostic: SettingsRecoveryDiagnostic,
		refresh: SettingsRefresh,
	): SettingDefinitionItem[] {
		const items: SettingDefinition[] = [
			{
				name: 'Settings recovery details',
				searchable: false,
				render: (setting) =>
					this.renderRecoveryDetails(setting.controlEl, diagnostic),
			},
		];
		if (diagnostic.kind !== 'unsupported-platform') {
			items.push({
				name: 'Retry',
				render: (setting) =>
					this.renderRecoveryAction(
						setting.controlEl,
						'Retry',
						() => this.host.retrySettingsLoad(),
						refresh,
					),
			});
		}
		if (isResettableSettingsDiagnostic(diagnostic)) {
			items.push({
				name: 'Reset',
				render: (setting) =>
					this.renderRecoveryAction(
						setting.controlEl,
						'Reset',
						() => this.host.resetSettings(),
						refresh,
					),
			});
		}
		return [{ type: 'group', heading: 'Settings recovery', items }];
	}

	private readyDefinitions(
		settings: ReadySettings,
		refresh: SettingsRefresh,
	): SettingDefinitionItem[] {
		const activityItems: SettingDefinition[] = ACTIVITY_FAMILIES.map(
			(family) => ({
				name: activityFamilyLabel(family),
				render: (setting) =>
					this.renderActivityFamily(
						setting.controlEl,
						family,
						settings.enabledActivityFamilies,
						refresh,
					),
			}),
		);
		activityItems.push({
			name: 'Save activity filters',
			render: (setting) =>
				this.renderActivitySave(setting.controlEl, refresh),
		});
		if (this.activitySaveStatus !== undefined) {
			activityItems.push({
				name: 'Activity filter status',
				searchable: false,
				render: (setting) => {
					setting.controlEl.createEl('p', {
						text: this.activitySaveStatus ?? '',
					});
				},
			});
		}

		const followItems: SettingDefinition[] = [
			{
				name: 'GitHub username',
				render: (setting) =>
					this.renderDraftInput(setting.controlEl, {
						name: 'GitHub username',
						id: 'devradar-follow-username',
						type: 'text',
						value: this.username,
						onInput: (input) => (this.username = input.value),
					}),
			},
			{
				name: 'Note destination',
				render: (setting) =>
					this.renderDraftInput(setting.controlEl, {
						name: 'Note destination',
						id: 'devradar-follow-note-path',
						type: 'text',
						value: this.notePath,
						placeholder: 'People/octocat.md',
						onInput: (input) => (this.notePath = input.value),
					}),
			},
			{
				name: 'Tracking start',
				render: (setting) =>
					this.renderTrackingStart(setting.controlEl, () =>
						this.refreshDeclarativeDomState(),
					),
			},
			{
				name: 'Start date',
				visible: () => this.trackingStartMode === 'from-date',
				render: (setting) =>
					this.renderDraftInput(setting.controlEl, {
						name: 'Start date',
						id: 'devradar-follow-from-date',
						type: 'date',
						value: this.fromDate,
						required: true,
						onInput: (input) => (this.fromDate = input.value),
					}),
			},
			{
				name: 'Start time',
				visible: () => this.trackingStartMode === 'from-date',
				render: (setting) => {
					this.fromTimeBadInput = false;
					this.renderDraftInput(setting.controlEl, {
						name: 'Start time',
						id: 'devradar-follow-from-time',
						type: 'time',
						value: this.fromTime,
						step: '60',
						onInput: (input) => {
							this.fromTime = input.value;
							this.fromTimeBadInput = input.validity.badInput;
						},
					});
					setting.controlEl.createEl('p', {
						text: 'Leave the time empty to begin at 00:00 on the selected date in your local timezone.',
					});
				},
			},
			{
				name: 'Follow',
				render: (setting) =>
					this.renderFollowAction(setting.controlEl, refresh),
			},
		];
		if (this.followStatus !== undefined) {
			followItems.push({
				name: 'Follow status',
				searchable: false,
				render: (setting) => {
					setting.controlEl.createEl('p', {
						text: this.followStatus ?? '',
					});
				},
			});
		}

		return [
			{
				type: 'group',
				heading: 'Activity families',
				items: activityItems,
			},
			{
				type: 'group',
				heading: 'Follow a GitHub user',
				items: followItems,
			},
			{
				name: 'Followed people',
				searchable: false,
				render: (setting) =>
					this.renderFollowedPeople(
						setting.controlEl,
						settings.followedPeople,
					),
			},
		];
	}

	private renderRecoveryAction(
		containerEl: HTMLElement,
		name: 'Retry' | 'Reset',
		action: () => Promise<void>,
		refresh: SettingsRefresh,
	): void {
		const button = containerEl.createEl('button', { text: name });
		button.disabled = this.host.isRecoveryActionPending();
		button.addEventListener('click', () => {
			if (button.disabled || this.host.isRecoveryActionPending()) return;
			this.rerenderAfterAction(action(), refresh);
		});
	}

	private renderRecoveryDetails(
		containerEl: HTMLElement,
		diagnostic: SettingsRecoveryDiagnostic,
	): void {
		containerEl.createEl('p', { text: 'Settings need attention.' });
		containerEl.createEl('p', {
			text: 'Settings-dependent configuration and synchronization are disabled until recovery succeeds. Existing notes remain untouched.',
		});
		containerEl.createEl('p', { text: diagnosticText(diagnostic) });
	}

	private renderDraftInput(
		containerEl: HTMLElement,
		options: {
			name: string;
			id: string;
			type: 'text' | 'date' | 'time';
			value: string;
			placeholder?: string;
			required?: boolean;
			step?: string;
			onInput: (input: HTMLInputElement) => void;
		},
	): void {
		const input = containerEl.createEl('input');
		input.id = options.id;
		input.type = options.type;
		input.value = options.value;
		input.setAttribute('aria-label', options.name);
		if (options.placeholder !== undefined)
			input.placeholder = options.placeholder;
		if (options.required !== undefined) input.required = options.required;
		if (options.step !== undefined) input.step = options.step;
		input.addEventListener('input', () => options.onInput(input));
	}

	private renderTrackingStart(
		containerEl: HTMLElement,
		refreshVisibility: SettingsRefresh,
	): void {
		const trackingStart = containerEl.createEl('select');
		trackingStart.id = 'devradar-follow-tracking-start';
		trackingStart.setAttribute('aria-label', 'Tracking start');
		for (const option of [
			['now', 'Now'],
			['available-recent', 'Available recent activity'],
			['from-date', 'Specific date'],
		] as const) {
			const element = trackingStart.createEl('option', {
				text: option[1],
			});
			element.value = option[0];
		}
		trackingStart.value = this.trackingStartMode;
		trackingStart.addEventListener('change', () => {
			this.trackingStartMode = trackingStart.value as TrackingStartMode;
			refreshVisibility();
		});
	}

	private renderActivityFamily(
		containerEl: HTMLElement,
		family: ActivityFamily,
		enabledActivityFamilies: readonly ActivityFamily[],
		refresh: SettingsRefresh,
	): void {
		const checkbox = containerEl.createEl('input');
		checkbox.id = `devradar-activity-family-${family}`;
		checkbox.type = 'checkbox';
		checkbox.setAttribute('aria-label', activityFamilyLabel(family));
		checkbox.checked = (
			this.activityFamiliesDraft ?? enabledActivityFamilies
		).includes(family);
		checkbox.disabled = this.activitySavePending;
		checkbox.addEventListener('change', () =>
			this.updateActivityDraft(
				family,
				checkbox.checked,
				enabledActivityFamilies,
				refresh,
			),
		);
	}

	private renderActivitySave(
		containerEl: HTMLElement,
		refresh: SettingsRefresh,
	): void {
		const button = containerEl.createEl('button', {
			text: 'Save activity filters',
		});
		button.disabled =
			this.activitySavePending ||
			this.activityFamiliesDraft === undefined;
		button.addEventListener('click', () =>
			this.submitActivityFilters(refresh, button),
		);
	}

	private renderFollowAction(
		containerEl: HTMLElement,
		refresh: SettingsRefresh,
	): void {
		const button = containerEl.createEl('button', { text: 'Follow' });
		button.disabled = this.followPending || this.host.isFollowPending();
		button.addEventListener('click', () =>
			this.submitFollow(refresh, button),
		);
	}

	private renderFollowedPeople(
		containerEl: HTMLElement,
		followedPeople: readonly FollowedPersonSummary[],
		includeHeading = false,
	): void {
		if (includeHeading)
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

	private updateActivityDraft(
		family: ActivityFamily,
		checked: boolean,
		enabledActivityFamilies: readonly ActivityFamily[],
		refresh: SettingsRefresh,
	): void {
		if (this.activitySavePending) return;
		const selected = new Set(
			this.activityFamiliesDraft ?? enabledActivityFamilies,
		);
		if (checked) selected.add(family);
		else selected.delete(family);
		this.activityFamiliesDraft = ACTIVITY_FAMILIES.filter((item) =>
			selected.has(item),
		);
		this.activitySaveStatus = undefined;
		refresh();
	}

	private submitActivityFilters(
		refresh: SettingsRefresh,
		button?: HTMLButtonElement,
	): void {
		if (
			this.activitySavePending ||
			this.activityFamiliesDraft === undefined
		)
			return;
		this.activitySavePending = true;
		this.activitySaveStatus = undefined;
		const families = [...this.activityFamiliesDraft];
		if (button) button.disabled = true;
		refresh();
		void this.host.saveActivityFamilies(families).then(
			(result) => {
				this.activitySavePending = false;
				if (result.kind === 'saved') {
					this.activityFamiliesDraft = undefined;
					this.activitySaveStatus = 'Activity filters saved.';
				} else {
					this.activitySaveStatus =
						'Activity filters could not be saved.';
				}
				refresh();
			},
			() => {
				this.activitySavePending = false;
				this.activitySaveStatus =
					'Activity filters could not be saved.';
				refresh();
			},
		);
	}

	private submitFollow(
		refresh: SettingsRefresh,
		button?: HTMLButtonElement,
	): void {
		if (this.followPending || this.host.isFollowPending()) return;
		const draft = this.draft();
		if (!draft) {
			refresh();
			return;
		}
		this.followPending = true;
		this.followStatus = undefined;
		if (button) button.disabled = true;
		refresh();
		void this.host.follow(draft).then(
			(result) => this.finishFollow(result, refresh),
			() =>
				this.finishFollow(
					{ kind: 'failed', reason: 'internal' },
					refresh,
				),
		);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const state = this.host.getSettingsState();
		if (state.kind === 'ready') {
			this.displayReady(
				containerEl,
				state.settings.followedPeople,
				state.settings.enabledActivityFamilies,
			);
			return;
		}

		const diagnostic = state.diagnostic;
		this.renderRecoveryDetails(containerEl, diagnostic);
		if (diagnostic.kind === 'unsupported-platform') return;
		const refresh = () => this.display();
		this.renderRecoveryAction(
			containerEl,
			'Retry',
			() => this.host.retrySettingsLoad(),
			refresh,
		);

		if (isResettableSettingsDiagnostic(diagnostic)) {
			this.renderRecoveryAction(
				containerEl,
				'Reset',
				() => this.host.resetSettings(),
				refresh,
			);
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
		enabledActivityFamilies: readonly ActivityFamily[],
	): void {
		this.displayActivityFilters(containerEl, enabledActivityFamilies);
		containerEl.createEl('p', { text: 'Follow a GitHub user' });
		const usernameLabel = containerEl.createEl('label', {
			text: 'GitHub username',
		});
		const username = containerEl.createEl('input');
		username.id = 'devradar-follow-username';
		usernameLabel.htmlFor = username.id;
		username.type = 'text';
		username.value = this.username;
		username.addEventListener('input', () => {
			this.username = username.value;
		});

		const notePathLabel = containerEl.createEl('label', {
			text: 'Note destination',
		});
		const notePath = containerEl.createEl('input');
		notePath.id = 'devradar-follow-note-path';
		notePathLabel.htmlFor = notePath.id;
		notePath.type = 'text';
		notePath.value = this.notePath;
		notePath.placeholder = 'People/octocat.md';
		notePath.addEventListener('input', () => {
			this.notePath = notePath.value;
		});

		const trackingStartLabel = containerEl.createEl('label', {
			text: 'Tracking start',
		});
		const trackingStart = containerEl.createEl('select');
		trackingStart.id = 'devradar-follow-tracking-start';
		trackingStartLabel.htmlFor = trackingStart.id;
		for (const option of [
			['now', 'Now'],
			['available-recent', 'Available recent activity'],
			['from-date', 'Specific date'],
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
			const fromDateLabel = containerEl.createEl('label', {
				text: 'Start date',
			});
			const fromDate = containerEl.createEl('input');
			fromDate.id = 'devradar-follow-from-date';
			fromDateLabel.htmlFor = fromDate.id;
			fromDate.type = 'date';
			fromDate.required = true;
			fromDate.value = this.fromDate;
			fromDate.addEventListener('input', () => {
				this.fromDate = fromDate.value;
			});

			const fromTimeLabel = containerEl.createEl('label', {
				text: 'Start time (optional)',
			});
			const fromTime = containerEl.createEl('input');
			fromTime.id = 'devradar-follow-from-time';
			fromTimeLabel.htmlFor = fromTime.id;
			fromTime.type = 'time';
			fromTime.step = '60';
			this.fromTimeBadInput = false;
			fromTime.value = this.fromTime;
			fromTime.addEventListener('input', () => {
				this.fromTime = fromTime.value;
				this.fromTimeBadInput = fromTime.validity.badInput;
			});
			containerEl.createEl('p', {
				text: 'Leave the time empty to begin at 00:00 on the selected date in your local timezone.',
			});
		}

		const follow = containerEl.createEl('button', { text: 'Follow' });
		const pending = this.followPending || this.host.isFollowPending();
		follow.disabled = pending;
		follow.addEventListener('click', () => {
			this.submitFollow(() => this.display(), follow);
		});

		if (this.followStatus !== undefined)
			containerEl.createEl('p', { text: this.followStatus });

		this.renderFollowedPeople(containerEl, followedPeople, true);
	}

	private displayActivityFilters(
		containerEl: HTMLElement,
		enabledActivityFamilies: readonly ActivityFamily[],
	): void {
		containerEl.createEl('p', { text: 'Activity families' });
		for (const family of ACTIVITY_FAMILIES) {
			const label = containerEl.createEl('label', {
				text: activityFamilyLabel(family),
			});
			const checkbox = containerEl.createEl('input');
			checkbox.id = `devradar-activity-family-${family}`;
			checkbox.type = 'checkbox';
			checkbox.checked = (
				this.activityFamiliesDraft ?? enabledActivityFamilies
			).includes(family);
			checkbox.disabled = this.activitySavePending;
			label.htmlFor = checkbox.id;
			checkbox.addEventListener('change', () => {
				this.updateActivityDraft(
					family,
					checkbox.checked,
					enabledActivityFamilies,
					() => this.display(),
				);
			});
		}

		const save = containerEl.createEl('button', {
			text: 'Save activity filters',
		});
		save.disabled =
			this.activitySavePending ||
			this.activityFamiliesDraft === undefined;
		save.addEventListener('click', () =>
			this.submitActivityFilters(() => this.display(), save),
		);
		if (this.activitySaveStatus !== undefined)
			containerEl.createEl('p', { text: this.activitySaveStatus });
	}

	private draft(): FollowDraft | undefined {
		if (this.trackingStartMode === 'from-date') {
			if (!isValidCalendarDate(this.fromDate)) {
				this.followStatus = this.fromDate
					? 'Enter a valid start date.'
					: 'Choose a start date to use date-based tracking.';
				return undefined;
			}
			if (
				this.fromTimeBadInput ||
				(this.fromTime && !isValidLocalTime(this.fromTime))
			) {
				this.followStatus = 'Enter a valid start time in HH:MM format.';
				return undefined;
			}
			const at = localDateTimeToUtc(this.fromDate, this.fromTime);
			if (!at) {
				this.followStatus = 'Enter a valid start date and time.';
				return undefined;
			}
			return {
				username: this.username,
				notePath: this.notePath,
				trackingStart: {
					mode: 'from-date',
					at,
				},
			};
		}
		return {
			username: this.username,
			notePath: this.notePath,
			trackingStart: { mode: this.trackingStartMode },
		};
	}

	private finishFollow(result: FollowResult, refresh: SettingsRefresh): void {
		this.followPending = false;
		this.followStatus = followStatus(result);
		refresh();
	}

	private rerenderAfterAction(
		action: Promise<void>,
		refresh: SettingsRefresh,
	): void {
		refresh();
		void action.then(
			() => refresh(),
			() => refresh(),
		);
	}
}

function isValidCalendarDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
	if (year < 1) return false;
	const calendar = new Date(0);
	calendar.setUTCFullYear(year, month - 1, day);
	calendar.setUTCHours(0, 0, 0, 0);
	return (
		calendar.getUTCFullYear() === year &&
		calendar.getUTCMonth() === month - 1 &&
		calendar.getUTCDate() === day
	);
}

function isValidLocalTime(value: string): boolean {
	if (!/^\d{2}:\d{2}$/.test(value)) return false;
	const [hour = 0, minute = 0] = value.split(':').map(Number);
	return hour < 24 && minute < 60;
}

function localDateTimeToUtc(
	dateValue: string,
	timeValue: string,
): string | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return undefined;
	if (timeValue && !/^\d{2}:\d{2}$/.test(timeValue)) return undefined;
	const [year, month, day] = dateValue.split('-').map(Number);
	const [hour, minute] = (timeValue || '00:00').split(':').map(Number);
	if (![year, month, day, hour, minute].every(Number.isFinite))
		return undefined;
	const local = new Date(0);
	local.setFullYear(year ?? 0, (month ?? 0) - 1, day);
	local.setHours(hour ?? 0, minute ?? 0, 0, 0);
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

function activityFamilyLabel(family: ActivityFamily): string {
	switch (family) {
		case 'push':
			return 'Pushes';
		case 'pull-request':
			return 'Pull requests';
		case 'issue':
			return 'Issues';
	}
}

function followStatus(result: FollowResult): string {
	if (result.kind === 'followed')
		return `Followed @${result.identity.username} (${result.noteDisposition}).`;
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
