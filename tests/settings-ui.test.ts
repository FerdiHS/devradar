import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
	Plugin: class {},
	requireApiVersion: () => true,
	PluginSettingTab: class {
		containerEl!: FakeElement;
		constructor(
			readonly app: unknown,
			readonly plugin: unknown,
		) {}
		update(): void {}
		refreshDomState(): void {}
	},
}));

import {
	DevRadarSettingTab,
	type SettingsRuntimeState,
	type SettingsTabHost,
} from '../src/settings';
import type { GitHubIdentity } from '../src/application/github-identity';
import { ACTIVITY_FAMILIES } from '../src/domain/activity';
import { createEmptySettingsV2 } from '../src/domain/settings';

class FakeElement {
	children: FakeElement[] = [];
	tag = '';
	text = '';
	id = '';
	htmlFor = '';
	disabled = false;
	type = '';
	value = '';
	placeholder = '';
	step = '';
	required = false;
	checked = false;
	validity = { badInput: false };
	attributes = new Map<string, string>();
	private listeners = new Map<string, () => void>();

	empty(): void {
		this.children = [];
	}

	createEl(_tag: string, options?: { text?: string }): FakeElement {
		const child = new FakeElement();
		child.tag = _tag;
		child.text = options?.text ?? '';
		this.children.push(child);
		return child;
	}

	addEventListener(event: string, listener: () => void): void {
		this.listeners.set(event, listener);
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	click(): void {
		this.listeners.get('click')?.();
	}

	emit(event: string): void {
		this.listeners.get(event)?.();
	}
}

function allElements(root: FakeElement): FakeElement[] {
	return root.children.flatMap((child) => [child, ...allElements(child)]);
}

type TestSettingDefinition = {
	name?: string;
	desc?: string;
	description?: string;
	aliases?: string[];
	searchable?: boolean;
	heading?: string;
	items?: TestSettingDefinition[];
	control?: unknown;
	action?: unknown;
	render?: (setting: { controlEl: FakeElement }) => void;
	visible?: () => boolean;
};

function getSettingDefinitions(
	tab: DevRadarSettingTab,
): TestSettingDefinition[] {
	return (
		tab as unknown as {
			getSettingDefinitions(): TestSettingDefinition[];
		}
	).getSettingDefinitions();
}

function flattenDefinitions(
	definitions: TestSettingDefinition[],
): TestSettingDefinition[] {
	return definitions.flatMap((definition) =>
		definition.items ? flattenDefinitions(definition.items) : [definition],
	);
}

function renderedDefinition(
	tab: DevRadarSettingTab,
	name: string,
	definitions = flattenDefinitions(getSettingDefinitions(tab)),
): FakeElement {
	const definition = definitions.find((item) => item.name === name);
	if (!definition?.render)
		throw new Error(`expected rendered setting definition: ${name}`);
	const controlEl = new FakeElement();
	definition.render({ controlEl });
	return controlEl;
}

const readyEmpty: SettingsRuntimeState = {
	kind: 'ready',
	settings: {
		schemaVersion: 2,
		followedPeople: [],
		enabledActivityFamilies: [...ACTIVITY_FAMILIES],
	},
};

function tabFor(state: SettingsRuntimeState, pending = false) {
	const resetSettings = vi.fn(async () => undefined);
	const retrySettingsLoad = vi.fn(async () => undefined);
	const follow = vi.fn<SettingsTabHost['follow']>(async () => ({
		kind: 'failed' as const,
		reason: 'internal' as const,
	}));
	const saveActivityFamilies = vi.fn<SettingsTabHost['saveActivityFamilies']>(
		async () => ({
			kind: 'saved' as const,
			settings: createEmptySettingsV2(),
		}),
	);
	const unfollow = vi.fn<SettingsTabHost['unfollow']>(async () => ({
		kind: 'cancelled',
	}));
	const changeTrackingStart = vi.fn<SettingsTabHost['changeTrackingStart']>(
		async () => ({ kind: 'failed', reason: 'internal' }),
	);
	const host: SettingsTabHost = {
		getSettingsState: () => state,
		isRecoveryActionPending: () => pending,
		retrySettingsLoad,
		resetSettings,
		isFollowPending: () => false,
		follow,
		isFollowManagementPending: () => false,
		unfollow,
		changeTrackingStart,
		saveActivityFamilies,
	};
	const tab = new DevRadarSettingTab({} as never, {} as never, host);
	const root = new FakeElement();
	(tab as unknown as { containerEl: FakeElement }).containerEl = root;
	return {
		host,
		tab,
		root,
		resetSettings,
		retrySettingsLoad,
		follow,
		unfollow,
		changeTrackingStart,
		saveActivityFamilies,
	};
}

function fromDateForm(view: ReturnType<typeof tabFor>) {
	view.tab.display();
	const username = allElements(view.root).find(
		(element) => element.id === 'devradar-follow-username',
	);
	const notePath = allElements(view.root).find(
		(element) => element.id === 'devradar-follow-note-path',
	);
	if (!username || !notePath) throw new Error('expected follow inputs');
	username.value = 'octocat';
	username.emit('input');
	notePath.value = 'People/octocat.md';
	notePath.emit('input');
	const trackingStart = allElements(view.root).find(
		(element) => element.tag === 'select',
	);
	if (!trackingStart) throw new Error('expected tracking-start select');
	trackingStart.value = 'from-date';
	trackingStart.emit('change');
	const date = allElements(view.root).find(
		(element) => element.type === 'date',
	);
	const time = allElements(view.root).find(
		(element) => element.type === 'time',
	);
	if (!date || !time) throw new Error('expected date and time inputs');
	return { date, time };
}

const ordinaryMalformed = {
	kind: 'recovery' as const,
	diagnostic: {
		kind: 'validation' as const,
		classification: 'ordinary-malformed' as const,
		error: {
			code: 'invalid-type' as const,
			path: '/x<script>',
			message: '<img src=x onerror=alert(1)>',
		},
	},
};

describe('DevRadarSettingTab declarative settings UI', () => {
	it('exposes stable searchable labels without putting runtime values in definition metadata', () => {
		const privateUsername = 'private-user-issue-133';
		const privateNotePath = 'Private/issue-133-notes.md';
		const privateStatus = 'Runtime status for issue-133';
		const view = tabFor({
			kind: 'ready',
			settings: {
				schemaVersion: 2,
				enabledActivityFamilies: [...ACTIVITY_FAMILIES],
				followedPeople: [
					{
						username: privateUsername,
						githubAccountId: '42',
						notePath: privateNotePath,
						trackingStart: { mode: 'available-recent' },
						syncState: { seenEvents: [], github: {} },
					},
				],
			},
		});
		Object.assign(view.tab, {
			followStatus: privateStatus,
			activitySaveStatus: privateStatus,
		});

		const definitions = getSettingDefinitions(view.tab);
		const rows = flattenDefinitions(definitions);
		const names = rows.map((definition) => definition.name);
		const metadata = definitions
			.flatMap((definition) => [
				definition.name,
				definition.heading,
				definition.desc,
				definition.description,
				...(definition.aliases ?? []),
			])
			.concat(
				rows.flatMap((definition) => [
					definition.name,
					definition.heading,
					definition.desc,
					definition.description,
					...(definition.aliases ?? []),
				]),
			)
			.filter((value): value is string => value !== undefined)
			.join('\n');

		expect(definitions.length).toBeGreaterThan(0);
		expect(names).toEqual(
			expect.arrayContaining([
				'Pushes',
				'Pull requests',
				'Issues',
				'Save activity filters',
				'GitHub username',
				'Note destination',
				'Tracking start',
				'Follow',
				'Unfollow',
				'Edit tracking start',
				'Followed people',
				'Follow status',
				'Activity filter status',
			]),
		);
		expect(
			rows.find((definition) => definition.name === 'Followed people')
				?.searchable,
		).toBe(false);
		expect(
			rows.find((definition) => definition.name === 'Unfollow')
				?.searchable,
		).not.toBe(false);
		expect(
			rows.find((definition) => definition.name === 'Edit tracking start')
				?.searchable,
		).not.toBe(false);
		expect(
			rows.find((definition) => definition.name === 'Follow status')
				?.searchable,
		).toBe(false);
		expect(
			rows.find(
				(definition) => definition.name === 'Activity filter status',
			)?.searchable,
		).toBe(false);
		expect(metadata).not.toContain(privateUsername);
		expect(metadata).not.toContain(privateNotePath);
		expect(metadata).not.toContain(privateStatus);
		expect(
			rows.every((definition) => definition.control === undefined),
		).toBe(true);
	});

	it('opens the tracking-start editor from its static searchable action', () => {
		const view = tabFor({
			kind: 'ready',
			settings: {
				schemaVersion: 2,
				enabledActivityFamilies: [...ACTIVITY_FAMILIES],
				followedPeople: [
					{
						username: 'private-person',
						githubAccountId: '42',
						notePath: 'Private/private-person.md',
						trackingStart: {
							mode: 'from-date',
							at: '2026-08-01T12:34:56.789Z',
						},
						syncState: { seenEvents: [], github: {} },
					},
				],
			},
		});
		const action = renderedDefinition(view.tab, 'Edit tracking start');
		allElements(action)
			.find((element) => element.tag === 'button')
			?.click();
		const personRow = renderedDefinition(view.tab, 'Followed people');
		const mode = allElements(personRow).find(
			(element) => element.id === 'devradar-edit-tracking-start-mode',
		);

		expect(mode?.value).toBe('from-date');
		expect(
			allElements(personRow)
				.filter((element) => element.tag === 'option')
				.map((element) => element.text),
		).toContain('Specific date');
	});

	it('routes the searchable Unfollow action by selected account ID', async () => {
		const view = tabFor({
			kind: 'ready',
			settings: {
				schemaVersion: 2,
				enabledActivityFamilies: [...ACTIVITY_FAMILIES],
				followedPeople: [
					{
						username: 'private-person',
						githubAccountId: '42',
						notePath: 'Private/private-person.md',
						trackingStart: { mode: 'available-recent' },
						syncState: { seenEvents: [], github: {} },
					},
				],
			},
		});
		const row = renderedDefinition(view.tab, 'Unfollow');
		const button = allElements(row).find(
			(element) => element.tag === 'button',
		);
		if (!button) throw new Error('expected Unfollow button');

		button.click();
		await Promise.resolve();
		await Promise.resolve();

		expect(view.unfollow).toHaveBeenCalledWith('42');
	});

	it('renders fail-closed recovery actions through the application host', () => {
		const ordinary = tabFor(ordinaryMalformed);
		const ordinaryRows = flattenDefinitions(
			getSettingDefinitions(ordinary.tab),
		);
		const retry = renderedDefinition(ordinary.tab, 'Retry', ordinaryRows);
		const reset = renderedDefinition(ordinary.tab, 'Reset', ordinaryRows);
		retry.children.find((element) => element.tag === 'button')?.click();
		reset.children.find((element) => element.tag === 'button')?.click();

		expect(ordinary.retrySettingsLoad).toHaveBeenCalledTimes(1);
		expect(ordinary.resetSettings).toHaveBeenCalledTimes(1);

		const future = tabFor({
			kind: 'recovery',
			diagnostic: {
				kind: 'validation',
				classification: 'future-schema',
				error: {
					code: 'unexpected-field',
					path: '/version',
					message: 'future schema',
				},
			},
		});
		const futureRows = flattenDefinitions(
			getSettingDefinitions(future.tab),
		);
		expect(futureRows.map((definition) => definition.name)).not.toContain(
			'Reset',
		);
		const unsupported = tabFor({
			kind: 'recovery',
			diagnostic: { kind: 'unsupported-platform' },
		});
		expect(
			flattenDefinitions(getSettingDefinitions(unsupported.tab)).map(
				(definition) => definition.name,
			),
		).not.toContain('Retry');
	});

	it('keeps Follow inputs local and submits the same date-based draft', async () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = 'UTC';
		try {
			const view = tabFor(readyEmpty);
			const update = vi.fn();
			const refreshDomState = vi.fn();
			Object.assign(view.tab, { update, refreshDomState });
			const rows = flattenDefinitions(getSettingDefinitions(view.tab));
			const username = allElements(
				renderedDefinition(view.tab, 'GitHub username', rows),
			).find((element) => element.tag === 'input');
			const notePath = allElements(
				renderedDefinition(view.tab, 'Note destination', rows),
			).find((element) => element.tag === 'input');
			const trackingStart = allElements(
				renderedDefinition(view.tab, 'Tracking start', rows),
			).find((element) => element.tag === 'select');
			if (!username || !notePath || !trackingStart)
				throw new Error('expected rendered Follow inputs');

			username.value = 'octocat';
			username.emit('input');
			notePath.value = 'People/octocat.md';
			notePath.emit('input');
			trackingStart.value = 'from-date';
			trackingStart.emit('change');

			expect(view.follow).not.toHaveBeenCalled();
			expect(refreshDomState).toHaveBeenCalledTimes(1);
			expect(
				rows
					.find((definition) => definition.name === 'Start date')
					?.visible?.(),
			).toBe(true);
			expect(
				rows
					.find((definition) => definition.name === 'Start time')
					?.visible?.(),
			).toBe(true);

			const date = allElements(
				renderedDefinition(view.tab, 'Start date', rows),
			).find((element) => element.type === 'date');
			const time = allElements(
				renderedDefinition(view.tab, 'Start time', rows),
			).find((element) => element.type === 'time');
			if (!date || !time)
				throw new Error('expected rendered date and time inputs');
			date.value = '2026-08-01';
			date.emit('input');
			time.value = '12:34';
			time.emit('input');

			const follow = allElements(
				renderedDefinition(view.tab, 'Follow', rows),
			).find((element) => element.tag === 'button');
			if (!follow) throw new Error('expected rendered Follow button');
			follow.click();
			await Promise.resolve();
			await Promise.resolve();

			expect(view.follow).toHaveBeenCalledWith({
				username: 'octocat',
				notePath: 'People/octocat.md',
				trackingStart: {
					mode: 'from-date',
					at: '2026-08-01T12:34:00.000Z',
				},
			});
			expect(update).toHaveBeenCalled();
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimezone;
		}
	});

	it('keeps activity-family edits local until explicit Save and accepts an empty selection', async () => {
		const view = tabFor(readyEmpty);
		const update = vi.fn();
		Object.assign(view.tab, { update });
		const rows = flattenDefinitions(getSettingDefinitions(view.tab));

		for (const family of ['Pushes', 'Pull requests', 'Issues']) {
			const checkbox = allElements(
				renderedDefinition(view.tab, family, rows),
			).find((element) => element.type === 'checkbox');
			if (!checkbox) throw new Error(`expected ${family} checkbox`);
			checkbox.checked = false;
			checkbox.emit('change');
		}
		expect(view.saveActivityFamilies).not.toHaveBeenCalled();

		const save = allElements(
			renderedDefinition(view.tab, 'Save activity filters', rows),
		).find((element) => element.tag === 'button');
		if (!save) throw new Error('expected activity filter Save button');
		save.click();
		save.click();
		await Promise.resolve();
		await Promise.resolve();

		expect(view.saveActivityFamilies).toHaveBeenCalledTimes(1);
		expect(view.saveActivityFamilies).toHaveBeenCalledWith([]);
		expect(update).toHaveBeenCalled();
	});

	it('disables and guards Follow and activity actions while pending', async () => {
		let releaseSave!: (
			result: Awaited<
				ReturnType<SettingsTabHost['saveActivityFamilies']>
			>,
		) => void;
		const pendingSave = new Promise<
			Awaited<ReturnType<SettingsTabHost['saveActivityFamilies']>>
		>((resolve) => {
			releaseSave = resolve;
		});
		const view = tabFor(readyEmpty);
		view.saveActivityFamilies.mockImplementation(() => pendingSave);
		const update = vi.fn();
		Object.assign(view.tab, { update });
		const rows = flattenDefinitions(getSettingDefinitions(view.tab));
		const username = allElements(
			renderedDefinition(view.tab, 'GitHub username', rows),
		).find((element) => element.tag === 'input');
		const notePath = allElements(
			renderedDefinition(view.tab, 'Note destination', rows),
		).find((element) => element.tag === 'input');
		if (!username || !notePath)
			throw new Error('expected rendered Follow inputs');
		username.value = 'octocat';
		username.emit('input');
		notePath.value = 'People/octocat.md';
		notePath.emit('input');
		const follow = allElements(
			renderedDefinition(view.tab, 'Follow', rows),
		).find((element) => element.tag === 'button');
		if (!follow) throw new Error('expected rendered Follow button');
		follow.click();
		follow.click();
		expect(view.follow).toHaveBeenCalledTimes(1);
		expect(follow.disabled).toBe(true);

		const save = allElements(
			renderedDefinition(view.tab, 'Save activity filters', rows),
		).find((element) => element.tag === 'button');
		if (!save) throw new Error('expected activity filter Save button');
		const checkbox = allElements(
			renderedDefinition(view.tab, 'Pushes', rows),
		).find((element) => element.type === 'checkbox');
		if (!checkbox) throw new Error('expected activity checkbox');
		checkbox.checked = false;
		checkbox.emit('change');
		save.click();
		save.click();
		expect(view.saveActivityFamilies).toHaveBeenCalledTimes(1);
		expect(save.disabled).toBe(true);
		expect(
			allElements(
				renderedDefinition(
					view.tab,
					'Pushes',
					flattenDefinitions(getSettingDefinitions(view.tab)),
				),
			).find((element) => element.type === 'checkbox')?.disabled,
		).toBe(true);

		releaseSave({ kind: 'saved', settings: createEmptySettingsV2() });
		await pendingSave;
	});
});

describe('DevRadarSettingTab recovery UI', () => {
	it('always shows Retry but only offers Reset for ordinary malformed data', () => {
		const ordinary = tabFor(ordinaryMalformed);
		ordinary.tab.display();
		expect(ordinary.root.children.map((child) => child.text)).toContain(
			'Retry',
		);
		expect(ordinary.root.children.map((child) => child.text)).toContain(
			'Reset',
		);

		const future = tabFor({
			kind: 'recovery',
			diagnostic: {
				kind: 'validation',
				classification: 'future-schema',
				error: {
					code: 'unexpected-field',
					path: '/unknownField',
					message: 'unexpected field',
				},
			},
		});
		future.tab.display();
		const futureText = future.root.children.map((child) => child.text);
		expect(futureText).toContain('Retry');
		expect(futureText.join('\n')).toContain('Update DevRadar');
		expect(futureText.join('\n')).toContain(
			'deliberately restore compatible plugin data',
		);
		expect(futureText).not.toContain('Reset');
	});

	it('does not offer Reset for non-resettable recovery states', () => {
		const diagnostics: SettingsRuntimeState[] = [
			{ kind: 'recovery', diagnostic: { kind: 'read-failure' } },
			{ kind: 'recovery', diagnostic: { kind: 'write-failure' } },
			{ kind: 'recovery', diagnostic: { kind: 'internal-failure' } },
			{
				kind: 'recovery',
				diagnostic: {
					kind: 'validation',
					classification: 'unclassifiable',
					error: {
						code: 'invalid-type',
						path: '',
						message: 'invalid type',
					},
				},
			},
		];

		for (const state of diagnostics) {
			const view = tabFor(state);
			view.tab.display();
			expect(view.root.children.map((child) => child.text)).not.toContain(
				'Reset',
			);
		}
	});

	it('does not offer recovery actions on an unsupported platform', () => {
		const view = tabFor({
			kind: 'recovery',
			diagnostic: { kind: 'unsupported-platform' },
		});
		view.tab.display();

		expect(view.root.children.map((child) => child.text)).not.toContain(
			'Retry',
		);
		expect(view.root.children.map((child) => child.text)).not.toContain(
			'Reset',
		);
	});

	it('invokes Retry', async () => {
		const view = tabFor(ordinaryMalformed);
		view.tab.display();
		view.root.children.find((child) => child.text === 'Retry')?.click();
		expect(view.retrySettingsLoad).toHaveBeenCalledTimes(1);
		await Promise.resolve();
	});

	it('disables both recovery actions immediately while one is pending', async () => {
		let release!: () => void;
		const pendingAction = new Promise<void>((resolve) => {
			release = resolve;
		});
		let pending = false;
		const retrySettingsLoad = vi.fn(() => {
			pending = true;
			return pendingAction.finally(() => {
				pending = false;
			});
		});
		const resetSettings = vi.fn(async () => undefined);
		const host: SettingsTabHost = {
			getSettingsState: () => ordinaryMalformed,
			isRecoveryActionPending: () => pending,
			retrySettingsLoad,
			resetSettings,
			isFollowPending: () => false,
			follow: vi.fn(async () => ({
				kind: 'failed' as const,
				reason: 'internal' as const,
			})),
			isFollowManagementPending: () => false,
			unfollow: vi.fn(async () => ({ kind: 'cancelled' as const })),
			changeTrackingStart: vi.fn(async () => ({
				kind: 'failed' as const,
				reason: 'internal' as const,
			})),
			saveActivityFamilies: vi.fn(async () => ({
				kind: 'saved' as const,
				settings: readyEmpty.settings,
			})),
		};
		const tab = new DevRadarSettingTab({} as never, {} as never, host);
		const root = new FakeElement();
		(tab as unknown as { containerEl: FakeElement }).containerEl = root;

		tab.display();
		root.children.find((child) => child.text === 'Retry')?.click();

		expect(
			root.children
				.filter(
					(child) => child.text === 'Retry' || child.text === 'Reset',
				)
				.every((child) => child.disabled),
		).toBe(true);

		release();
		await pendingAction;
	});

	it('disables recovery actions when the host reports pending', () => {
		const pending = tabFor(ordinaryMalformed, true);
		pending.tab.display();
		expect(
			pending.root.children
				.filter(
					(child) => child.text === 'Retry' || child.text === 'Reset',
				)
				.every((child) => child.disabled),
		).toBe(true);
	});

	it('re-renders after a recovery action rejects', async () => {
		const view = tabFor({
			kind: 'recovery',
			diagnostic: { kind: 'read-failure' },
		});
		view.retrySettingsLoad.mockRejectedValue(
			new Error('unexpected failure'),
		);
		view.tab.display();
		const display = vi.spyOn(view.tab, 'display');
		view.root.children.find((child) => child.text === 'Retry')?.click();
		await Promise.resolve();
		await Promise.resolve();

		expect(display).toHaveBeenCalledTimes(2);
	});

	it('renders hostile validation details and invokes reset', async () => {
		const view = tabFor(ordinaryMalformed);
		view.tab.display();
		const text = view.root.children.map((child) => child.text).join('\n');
		expect(text).toContain('<img src=x onerror=alert(1)>');
		expect(text).toContain('/x<script>');
		expect(text).toContain('Existing notes remain untouched.');

		view.root.children.find((child) => child.text === 'Reset')?.click();

		expect(view.resetSettings).toHaveBeenCalledTimes(1);
		await Promise.resolve();
	});
});

describe('DevRadarSettingTab ready Follow UI', () => {
	it('keeps the tracking-start editor input mounted while updating Save', () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = 'UTC';
		try {
			const view = tabFor({
				kind: 'ready',
				settings: {
					schemaVersion: 2,
					enabledActivityFamilies: [...ACTIVITY_FAMILIES],
					followedPeople: [
						{
							username: 'octocat',
							githubAccountId: '583231',
							notePath: 'People/octocat.md',
							trackingStart: {
								mode: 'from-date',
								at: '2026-08-01T12:34:00.000Z',
							},
							syncState: { seenEvents: [], github: {} },
						},
					],
				},
			});
			view.tab.display();
			allElements(view.root)
				.find(
					(element) =>
						element.tag === 'button' &&
						element.text === 'Edit tracking start',
				)
				?.click();

			const date = allElements(view.root).find(
				(element) => element.id === 'devradar-edit-tracking-start-date',
			);
			const save = allElements(view.root).find(
				(element) =>
					element.tag === 'button' &&
					element.text === 'Save tracking start',
			);
			if (!date || !save) throw new Error('expected date editor and Save');
			expect(save.disabled).toBe(true);

			date.value = '2026-08-02';
			date.emit('input');

			expect(allElements(view.root)).toContain(date);
			expect(save.disabled).toBe(false);
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimezone;
		}
	});

	it('renders the minimal Follow form and explicit empty state', () => {
		const view = tabFor(readyEmpty);
		view.tab.display();
		const elements = allElements(view.root);
		const text = elements.map((element) => element.text).join('\n');

		expect(text).toContain('GitHub username');
		expect(text).toContain('Note destination');
		expect(text).toContain('Tracking start');
		expect(text).toContain('No followed people yet.');
		expect(
			elements.filter((element) => element.tag === 'option'),
		).toHaveLength(3);
		expect(
			elements
				.filter((element) => element.tag === 'option')
				.map((element) => element.text),
		).toEqual(['Now', 'Available recent activity', 'Specific date']);
		expect(
			elements.filter((element) => element.tag === 'input'),
		).toHaveLength(5);
		expect(
			elements
				.filter((element) => element.tag === 'label')
				.map((element) => element.htmlFor),
		).toEqual([
			'devradar-activity-family-push',
			'devradar-activity-family-pull-request',
			'devradar-activity-family-issue',
			'devradar-follow-username',
			'devradar-follow-note-path',
			'devradar-follow-tracking-start',
		]);
		expect(
			elements
				.filter(
					(element) =>
						element.tag === 'input' || element.tag === 'select',
				)
				.map((element) => element.id),
		).toEqual([
			'devradar-activity-family-push',
			'devradar-activity-family-pull-request',
			'devradar-activity-family-issue',
			'devradar-follow-username',
			'devradar-follow-note-path',
			'devradar-follow-tracking-start',
		]);
	});

	it('allows any global activity-family subset and saves it explicitly', async () => {
		const view = tabFor(readyEmpty);
		view.tab.display();
		const issue = allElements(view.root).find(
			(element) => element.id === 'devradar-activity-family-issue',
		);
		if (!issue) throw new Error('expected issue activity checkbox');
		issue.checked = false;
		issue.emit('change');

		const save = allElements(view.root).find(
			(element) =>
				element.tag === 'button' &&
				element.text === 'Save activity filters',
		);
		if (!save) throw new Error('expected activity filter save button');
		expect(save.disabled).toBe(false);
		save.click();
		await Promise.resolve();
		await Promise.resolve();

		expect(view.saveActivityFamilies).toHaveBeenCalledWith([
			'push',
			'pull-request',
		]);
		expect(allElements(view.root).map((element) => element.text)).toContain(
			'Activity filters saved.',
		);
	});

	it('allows saving an empty global activity-family selection', async () => {
		const view = tabFor(readyEmpty);
		view.tab.display();

		for (const family of ACTIVITY_FAMILIES) {
			const checkbox = allElements(view.root).find(
				(element) =>
					element.id === `devradar-activity-family-${family}`,
			);
			if (!checkbox) throw new Error(`expected ${family} checkbox`);
			checkbox.checked = false;
			checkbox.emit('change');
		}

		const save = allElements(view.root).find(
			(element) =>
				element.tag === 'button' &&
				element.text === 'Save activity filters',
		);
		if (!save) throw new Error('expected activity filter save button');
		expect(save.disabled).toBe(false);
		save.click();
		await Promise.resolve();
		await Promise.resolve();

		expect(view.saveActivityFamilies).toHaveBeenCalledWith([]);
	});

	it('locks activity-family controls while a save is pending', async () => {
		let release!: (
			result: Awaited<
				ReturnType<SettingsTabHost['saveActivityFamilies']>
			>,
		) => void;
		const pending = new Promise<
			Awaited<ReturnType<SettingsTabHost['saveActivityFamilies']>>
		>((resolve) => {
			release = resolve;
		});
		const view = tabFor(readyEmpty);
		view.saveActivityFamilies.mockImplementationOnce(() => pending);
		view.tab.display();
		const issue = allElements(view.root).find(
			(element) => element.id === 'devradar-activity-family-issue',
		);
		if (!issue) throw new Error('expected issue activity checkbox');
		issue.checked = false;
		issue.emit('change');
		const save = allElements(view.root).find(
			(element) =>
				element.tag === 'button' &&
				element.text === 'Save activity filters',
		);
		if (!save) throw new Error('expected activity filter save button');
		save.click();

		const pendingIssue = allElements(view.root).find(
			(element) => element.id === 'devradar-activity-family-issue',
		);
		expect(pendingIssue?.disabled).toBe(true);
		pendingIssue!.checked = true;
		pendingIssue!.emit('change');
		expect(pendingIssue!.disabled).toBe(true);

		release({ kind: 'saved', settings: createEmptySettingsV2() });
		await pending;
	});

	it('renders canonical followed-person details in persisted order', () => {
		const view = tabFor({
			kind: 'ready',
			settings: {
				schemaVersion: 2,
				enabledActivityFamilies: [...ACTIVITY_FAMILIES],
				followedPeople: [
					{
						username: 'first',
						githubAccountId: '1',
						notePath: 'People/first.md',
						trackingStart: { mode: 'available-recent' },
						syncState: { seenEvents: [], github: {} },
					},
					{
						username: 'second',
						githubAccountId: '2',
						notePath: 'People/second.md',
						trackingStart: {
							mode: 'from-date',
							at: '2026-08-01T00:00:00.000Z',
						},
						syncState: { seenEvents: [], github: {} },
					},
				],
			},
		});
		view.tab.display();
		const items = allElements(view.root)
			.filter((element) => element.tag === 'li')
			.map((element) => element.text);

		expect(items).toEqual([
			'@first — People/first.md — Available recent activity',
			'@second — People/second.md — Date & time: 2026-08-01T00:00:00.000Z',
		]);
	});

	it('renders an imperative Unfollow control for each followed person', async () => {
		const view = tabFor({
			kind: 'ready',
			settings: {
				schemaVersion: 2,
				enabledActivityFamilies: [...ACTIVITY_FAMILIES],
				followedPeople: [
					{
						username: 'octocat',
						githubAccountId: '583231',
						notePath: 'People/octocat.md',
						trackingStart: { mode: 'available-recent' },
						syncState: { seenEvents: [], github: {} },
					},
				],
			},
		});
		view.tab.display();
		const item = allElements(view.root).find(
			(element) => element.tag === 'li',
		);
		const button = item?.children.find(
			(element) => element.tag === 'button',
		);
		if (!button) throw new Error('expected inline Unfollow button');

		button.click();
		await Promise.resolve();
		await Promise.resolve();

		expect(view.unfollow).toHaveBeenCalledWith('583231');
	});

	it('allows resetting an existing Now start to a fresh commit-time value', async () => {
		const view = tabFor({
			kind: 'ready',
			settings: {
				schemaVersion: 2,
				enabledActivityFamilies: [...ACTIVITY_FAMILIES],
				followedPeople: [
					{
						username: 'octocat',
						githubAccountId: '583231',
						notePath: 'People/octocat.md',
						trackingStart: {
							mode: 'from-now',
							at: '2026-08-01T04:34:56.789Z',
						},
						syncState: { seenEvents: [], github: {} },
					},
				],
			},
		});
		view.changeTrackingStart.mockResolvedValue({
			kind: 'updated',
			username: 'octocat',
			trackingStart: {
				mode: 'from-now',
				at: '2026-09-29T00:00:00.000Z',
			},
		});
		view.tab.display();
		allElements(view.root)
			.find(
				(element) =>
					element.tag === 'button' &&
					element.text === 'Edit tracking start',
			)
			?.click();

		const save = allElements(view.root).find(
			(element) =>
				element.tag === 'button' &&
				element.text === 'Save tracking start',
		);
		if (!save) throw new Error('expected tracking-start Save');
		expect(save.disabled).toBe(false);
		save.click();
		await Promise.resolve();
		await Promise.resolve();

		expect(view.changeTrackingStart).toHaveBeenCalledWith('583231', {
			mode: 'now',
		});
	});

	it('shows the exact saved date, preserves sub-minute time on no-op, and saves a changed local minute', async () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = 'Asia/Singapore';
		try {
			const view = tabFor({
				kind: 'ready',
				settings: {
					schemaVersion: 2,
					enabledActivityFamilies: [...ACTIVITY_FAMILIES],
					followedPeople: [
						{
							username: 'octocat',
							githubAccountId: '583231',
							notePath: 'People/octocat.md',
							trackingStart: {
								mode: 'from-date',
								at: '2026-08-01T04:34:56.789Z',
							},
							syncState: { seenEvents: [], github: {} },
						},
					],
				},
			});
			view.changeTrackingStart.mockResolvedValue({
				kind: 'updated',
				username: 'octocat',
				trackingStart: {
					mode: 'from-date',
					at: '2026-08-01T04:35:00.000Z',
				},
			});
			view.tab.display();
			expect(
				allElements(view.root)
					.map((item) => item.text)
					.join('\n'),
			).toContain('2026-08-01T04:34:56.789Z');
			allElements(view.root)
				.find(
					(element) =>
						element.tag === 'button' &&
						element.text === 'Edit tracking start',
				)
				?.click();

			const mode = allElements(view.root).find(
				(element) => element.id === 'devradar-edit-tracking-start-mode',
			);
			const date = allElements(view.root).find(
				(element) => element.id === 'devradar-edit-tracking-start-date',
			);
			const time = allElements(view.root).find(
				(element) => element.id === 'devradar-edit-tracking-start-time',
			);
			const save = allElements(view.root).find(
				(element) =>
					element.tag === 'button' &&
					element.text === 'Save tracking start',
			);
			expect(mode?.value).toBe('from-date');
			expect(date?.value).toBe('2026-08-01');
			expect(time?.value).toBe('12:34');
			expect(save?.disabled).toBe(true);

			if (!time) throw new Error('expected tracking-start time input');
			time.value = '12:35';
			time.emit('input');
			allElements(view.root)
				.find(
					(element) =>
						element.tag === 'button' &&
						element.text === 'Save tracking start',
				)
				?.click();
			await Promise.resolve();
			await Promise.resolve();

			expect(view.changeTrackingStart).toHaveBeenCalledWith('583231', {
				mode: 'from-date',
				at: '2026-08-01T04:35:00.000Z',
			});
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimezone;
		}
	});

	it('disables date edits for invalid and future values and submits valid mode choices', async () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = 'UTC';
		try {
			const view = tabFor({
				kind: 'ready',
				settings: {
					schemaVersion: 2,
					enabledActivityFamilies: [...ACTIVITY_FAMILIES],
					followedPeople: [
						{
							username: 'octocat',
							githubAccountId: '583231',
							notePath: 'People/octocat.md',
							trackingStart: { mode: 'available-recent' },
							syncState: { seenEvents: [], github: {} },
						},
					],
				},
			});
			view.changeTrackingStart.mockResolvedValue({
				kind: 'updated',
				username: 'octocat',
				trackingStart: { mode: 'available-recent' },
			});
			view.tab.display();
			allElements(view.root)
				.find(
					(element) =>
						element.tag === 'button' &&
						element.text === 'Edit tracking start',
				)
				?.click();
			let mode = allElements(view.root).find(
				(element) => element.id === 'devradar-edit-tracking-start-mode',
			);
			if (!mode) throw new Error('expected tracking-start mode selector');
			expect(
				mode.children
					.filter((element) => element.tag === 'option')
					.map((element) => element.text),
			).toEqual(['Now', 'Available recent activity', 'Specific date']);
			mode.value = 'from-date';
			mode.emit('change');
			let date = allElements(view.root).find(
				(element) => element.id === 'devradar-edit-tracking-start-date',
			);
			let save = allElements(view.root).find(
				(element) =>
					element.tag === 'button' &&
					element.text === 'Save tracking start',
			);
			if (!date || !save) throw new Error('expected date editor');
			date.value = 'not-a-date';
			date.emit('input');
			save = allElements(view.root).find(
				(element) =>
					element.tag === 'button' &&
					element.text === 'Save tracking start',
			);
			expect(save?.disabled).toBe(true);
			date = allElements(view.root).find(
				(element) => element.id === 'devradar-edit-tracking-start-date',
			);
			if (!date) throw new Error('expected date editor');
			date.value = '2099-01-01';
			date.emit('input');
			save = allElements(view.root).find(
				(element) =>
					element.tag === 'button' &&
					element.text === 'Save tracking start',
			);
			expect(save?.disabled).toBe(true);
			date = allElements(view.root).find(
				(element) => element.id === 'devradar-edit-tracking-start-date',
			);
			if (!date) throw new Error('expected date editor');
			date.value = '2020-01-01';
			date.emit('input');
			save = allElements(view.root).find(
				(element) =>
					element.tag === 'button' &&
					element.text === 'Save tracking start',
			);
			if (!save) throw new Error('expected tracking-start Save');
			expect(save.disabled).toBe(false);
			save.click();
			await Promise.resolve();
			await Promise.resolve();
			expect(view.changeTrackingStart).toHaveBeenCalledWith('583231', {
				mode: 'from-date',
				at: '2020-01-01T00:00:00.000Z',
			});
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimezone;
		}
	});

	it('submits entered fields and date mode, then maps a stable result', async () => {
		const view = tabFor(readyEmpty);
		view.follow.mockResolvedValue({
			kind: 'skipped',
			reason: 'provider-policy',
		});
		const { date, time } = fromDateForm(view);
		expect(
			allElements(view.root).find(
				(element) =>
					element.tag === 'label' && element.text === 'Start date',
			)?.htmlFor,
		).toBe('devradar-follow-from-date');
		expect(date.id).toBe('devradar-follow-from-date');
		expect(time.id).toBe('devradar-follow-from-time');
		expect(date.required).toBe(true);
		expect(time.required).toBe(false);
		expect(allElements(view.root).map((element) => element.text)).toContain(
			'Leave the time empty to begin at 00:00 on the selected date in your local timezone.',
		);
		time.value = '12:34';
		time.emit('input');
		date.value = '0001-08-01';
		date.emit('input');

		const button = allElements(view.root).find(
			(element) => element.tag === 'button' && element.text === 'Follow',
		);
		if (!button) throw new Error('expected Follow button');
		button.click();
		await Promise.resolve();
		await Promise.resolve();

		const expected = new Date(0);
		expected.setFullYear(1, 7, 1);
		expected.setHours(12, 34, 0, 0);
		expect(view.follow).toHaveBeenCalledWith({
			username: 'octocat',
			notePath: 'People/octocat.md',
			trackingStart: {
				mode: 'from-date',
				at: expected.toISOString(),
			},
		});
		expect(
			allElements(view.root)
				.map((element) => element.text)
				.join('\n'),
		).toContain(
			'Follow skipped because GitHub requests are temporarily unavailable.',
		);
	});

	it('submits date-only input at local midnight', async () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = 'America/Los_Angeles';
		try {
			const view = tabFor(readyEmpty);
			const { date } = fromDateForm(view);
			date.value = '2026-08-01';
			date.emit('input');
			allElements(view.root)
				.find(
					(element) =>
						element.tag === 'button' && element.text === 'Follow',
				)
				?.click();
			await Promise.resolve();
			await Promise.resolve();

			expect(view.follow).toHaveBeenCalledWith({
				username: 'octocat',
				notePath: 'People/octocat.md',
				trackingStart: {
					mode: 'from-date',
					at: '2026-08-01T07:00:00.000Z',
				},
			});
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimezone;
		}
	});

	it('passes future date conversion to application validation', async () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = 'America/Los_Angeles';
		try {
			const view = tabFor(readyEmpty);
			const { date } = fromDateForm(view);
			date.value = '2026-08-29';
			date.emit('input');
			allElements(view.root)
				.find(
					(element) =>
						element.tag === 'button' && element.text === 'Follow',
				)
				?.click();
			await Promise.resolve();
			await Promise.resolve();

			expect(view.follow).toHaveBeenCalledWith({
				username: 'octocat',
				notePath: 'People/octocat.md',
				trackingStart: {
					mode: 'from-date',
					at: '2026-08-29T07:00:00.000Z',
				},
			});
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimezone;
		}
	});

	it.each([
		[
			'missing date',
			'',
			'',
			'Choose a start date to use date-based tracking.',
		],
		[
			'invalid time',
			'2026-08-01',
			'12:',
			'Enter a valid start time in HH:MM format.',
		],
		[
			'out-of-range time',
			'2026-08-01',
			'25:00',
			'Enter a valid start time in HH:MM format.',
		],
		[
			'invalid calendar date',
			'2026-02-31',
			'',
			'Enter a valid start date.',
		],
		['year zero date', '0000-01-01', '', 'Enter a valid start date.'],
	] as const)(
		'reports %s before submitting Follow',
		async (_name, dateValue, timeValue, message) => {
			const view = tabFor(readyEmpty);
			const { date, time } = fromDateForm(view);
			date.value = dateValue;
			time.value = timeValue;
			date.emit('input');
			time.emit('input');
			allElements(view.root)
				.find(
					(element) =>
						element.tag === 'button' && element.text === 'Follow',
				)
				?.click();

			expect(view.follow).not.toHaveBeenCalled();
			expect(
				allElements(view.root)
					.map((element) => element.text)
					.join('\n'),
			).toContain(message);
		},
	);

	it('recovers from native incomplete time input after rerender', async () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = 'America/Los_Angeles';
		try {
			const view = tabFor(readyEmpty);
			const { date, time } = fromDateForm(view);
			date.value = '2026-08-01';
			time.value = '';
			time.validity.badInput = true;
			date.emit('input');
			time.emit('input');
			allElements(view.root)
				.find(
					(element) =>
						element.tag === 'button' && element.text === 'Follow',
				)
				?.click();

			expect(view.follow).not.toHaveBeenCalled();
			expect(
				allElements(view.root)
					.map((element) => element.text)
					.join('\n'),
			).toContain('Enter a valid start time in HH:MM format.');

			allElements(view.root)
				.find(
					(element) =>
						element.tag === 'button' && element.text === 'Follow',
				)
				?.click();
			await Promise.resolve();
			await Promise.resolve();

			expect(view.follow).toHaveBeenCalledWith({
				username: 'octocat',
				notePath: 'People/octocat.md',
				trackingStart: {
					mode: 'from-date',
					at: '2026-08-01T07:00:00.000Z',
				},
			});
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimezone;
		}
	});

	it('disables Follow and prevents duplicate submissions while pending', async () => {
		let release!: (result: {
			kind: 'followed';
			identity: GitHubIdentity;
			noteDisposition: 'created';
		}) => void;
		const pending = new Promise<{
			kind: 'followed';
			identity: GitHubIdentity;
			noteDisposition: 'created';
		}>((resolve) => {
			release = resolve;
		});
		const follow = vi.fn(() => pending);
		const host: SettingsTabHost = {
			getSettingsState: () => readyEmpty,
			isRecoveryActionPending: () => false,
			retrySettingsLoad: vi.fn(async () => undefined),
			resetSettings: vi.fn(async () => undefined),
			isFollowPending: () => false,
			follow,
			isFollowManagementPending: () => false,
			unfollow: vi.fn(async () => ({ kind: 'cancelled' as const })),
			changeTrackingStart: vi.fn(async () => ({
				kind: 'failed' as const,
				reason: 'internal' as const,
			})),
			saveActivityFamilies: vi.fn(async () => ({
				kind: 'saved' as const,
				settings: readyEmpty.settings,
			})),
		};
		const tab = new DevRadarSettingTab({} as never, {} as never, host);
		const root = new FakeElement();
		(tab as unknown as { containerEl: FakeElement }).containerEl = root;
		tab.display();
		const button = allElements(root).find(
			(element) => element.tag === 'button' && element.text === 'Follow',
		);
		if (!button) throw new Error('expected Follow button');

		button.click();
		button.click();
		expect(follow).toHaveBeenCalledTimes(1);
		const pendingButton = allElements(root).find(
			(element) => element.tag === 'button' && element.text === 'Follow',
		);
		expect(pendingButton?.disabled).toBe(true);

		release({
			kind: 'followed',
			identity: {
				username: 'octocat',
				githubAccountId: '42',
			},
			noteDisposition: 'created',
		});
		await pending;
		await Promise.resolve();
		const readyButton = allElements(root).find(
			(element) => element.tag === 'button' && element.text === 'Follow',
		);
		expect(readyButton?.disabled).toBe(false);
		expect(
			allElements(root)
				.map((element) => element.text)
				.join('\n'),
		).toContain('Followed @octocat (created).');
	});
});
