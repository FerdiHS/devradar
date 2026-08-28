import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
	Plugin: class {},
	PluginSettingTab: class {
		containerEl!: FakeElement;
		constructor(
			readonly app: unknown,
			readonly plugin: unknown,
		) {}
	},
}));

import {
	DevRadarSettingTab,
	type SettingsRuntimeState,
	type SettingsTabHost,
} from '../src/settings';
import type { FollowedPersonV1 } from '../src/domain/settings';

class FakeElement {
	children: FakeElement[] = [];
	tag = '';
	text = '';
	disabled = false;
	type = '';
	value = '';
	placeholder = '';
	step = '';
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

const readyEmpty: SettingsRuntimeState = {
	kind: 'ready',
	settings: { schemaVersion: 1, followedPeople: [] },
};

function tabFor(state: SettingsRuntimeState, pending = false) {
	const resetSettings = vi.fn(async () => undefined);
	const retrySettingsLoad = vi.fn(async () => undefined);
	const follow = vi.fn<SettingsTabHost['follow']>(async () => ({
		kind: 'failed' as const,
		reason: 'internal' as const,
	}));
	const host: SettingsTabHost = {
		getSettingsState: () => state,
		isRecoveryActionPending: () => pending,
		retrySettingsLoad,
		resetSettings,
		isFollowPending: () => false,
		follow,
	};
	const tab = new DevRadarSettingTab({} as never, {} as never, host);
	const root = new FakeElement();
	(tab as unknown as { containerEl: FakeElement }).containerEl = root;
	return { host, tab, root, resetSettings, retrySettingsLoad, follow };
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
			elements.filter((element) => element.tag === 'input'),
		).toHaveLength(2);
	});

	it('renders canonical followed-person details in persisted order', () => {
		const view = tabFor({
			kind: 'ready',
			settings: {
				schemaVersion: 1,
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

	it('submits entered fields and date mode, then maps a stable result', async () => {
		const view = tabFor(readyEmpty);
		view.follow.mockResolvedValue({
			kind: 'skipped',
			reason: 'provider-policy',
		});
		view.tab.display();

		let inputs = allElements(view.root).filter(
			(element) => element.tag === 'input',
		);
		inputs[0]!.value = 'octocat';
		inputs[0]!.emit('input');
		inputs[1]!.value = 'People/octocat.md';
		inputs[1]!.emit('input');

		const trackingStart = allElements(view.root).find(
			(element) => element.tag === 'select',
		);
		if (!trackingStart) throw new Error('expected tracking-start select');
		trackingStart.value = 'from-date';
		trackingStart.emit('change');

		inputs = allElements(view.root).filter(
			(element) => element.tag === 'input',
		);
		const date = inputs.find(
			(element) => element.type === 'datetime-local',
		);
		if (!date) throw new Error('expected date input');
		date.value = '2026-08-01T12:34';
		date.emit('input');

		const button = allElements(view.root).find(
			(element) => element.tag === 'button' && element.text === 'Follow',
		);
		if (!button) throw new Error('expected Follow button');
		button.click();
		await Promise.resolve();
		await Promise.resolve();

		expect(view.follow).toHaveBeenCalledWith({
			username: 'octocat',
			notePath: 'People/octocat.md',
			trackingStart: {
				mode: 'from-date',
				at: new Date(2026, 7, 1, 12, 34).toISOString(),
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

	it('disables Follow and prevents duplicate submissions while pending', async () => {
		let release!: (result: {
			kind: 'followed';
			person: FollowedPersonV1;
			noteDisposition: 'created';
		}) => void;
		const pending = new Promise<{
			kind: 'followed';
			person: FollowedPersonV1;
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
			person: {
				username: 'octocat',
				githubAccountId: '42',
				notePath: 'People/octocat.md',
				trackingStart: { mode: 'available-recent' },
				syncState: { seenEvents: [], github: {} },
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
