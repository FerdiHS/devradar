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

class FakeElement {
	children: FakeElement[] = [];
	text = '';
	disabled = false;
	private listeners = new Map<string, () => void>();

	empty(): void {
		this.children = [];
	}

	createEl(_tag: string, options?: { text?: string }): FakeElement {
		const child = new FakeElement();
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
}

function tabFor(state: SettingsRuntimeState, pending = false) {
	const resetSettings = vi.fn(async () => undefined);
	const retrySettingsLoad = vi.fn(async () => undefined);
	const host: SettingsTabHost = {
		getSettingsState: () => state,
		isRecoveryActionPending: () => pending,
		retrySettingsLoad,
		resetSettings,
	};
	const tab = new DevRadarSettingTab({} as never, {} as never, host);
	const root = new FakeElement();
	(tab as unknown as { containerEl: FakeElement }).containerEl = root;
	return { host, tab, root, resetSettings, retrySettingsLoad };
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
