import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
	Plugin: class {},
	PluginSettingTab: class {
		constructor(
			readonly app: unknown,
			readonly plugin: unknown,
		) {}
	},
}));

import DevRadarPlugin from '../src/main';

const EMPTY = { schemaVersion: 1, followedPeople: [] };

type FakePlugin = DevRadarPlugin & {
	loadData: () => Promise<unknown>;
	saveData: (data: unknown) => Promise<void>;
	addSettingTab: ReturnType<typeof vi.fn>;
	app: unknown;
};

function fakePlugin(
	loadData: () => Promise<unknown>,
	saveData: (data: unknown) => Promise<void> = async () => undefined,
): FakePlugin {
	const plugin = new DevRadarPlugin({} as never, {} as never) as FakePlugin;
	plugin.app = {} as never;
	plugin.loadData = loadData;
	plugin.saveData = saveData;
	plugin.addSettingTab = vi.fn() as FakePlugin['addSettingTab'];
	return plugin;
}

describe('DevRadarPlugin settings lifecycle', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('registers the settings tab when initial reading fails', async () => {
		const plugin = fakePlugin(async () => {
			throw new Error('unavailable');
		});

		await plugin.onload();

		expect(plugin.addSettingTab.mock.calls).toHaveLength(1);
		expect(plugin.getSettingsState()).toEqual({
			kind: 'recovery',
			diagnostic: { kind: 'read-failure' },
		});
	});

	it('serializes concurrent retries without a global operation guard', async () => {
		let release!: (value: unknown) => void;
		const pending = new Promise<unknown>((resolve) => {
			release = resolve;
		});
		let reads = 0;
		const plugin = fakePlugin(async () => {
			reads += 1;
			if (reads === 1) throw new Error('unavailable');
			return pending;
		});

		await plugin.onload();
		const first = plugin.retrySettingsLoad();
		const second = plugin.retrySettingsLoad();
		expect(plugin.isRecoveryActionPending()).toBe(true);
		release(EMPTY);
		await Promise.all([first, second]);

		expect(reads).toBe(2);
		expect(plugin.getSettingsState().kind).toBe('ready');
	});

	it('commits reset settings only after the persistence write succeeds', async () => {
		const saveData = vi.fn(async () => undefined);
		const plugin = fakePlugin(async () => ({ malformed: true }), saveData);

		await plugin.onload();
		await plugin.resetSettings();

		expect(saveData).toHaveBeenCalledWith(EMPTY);
		expect(plugin.getSettingsState()).toEqual({
			kind: 'ready',
			settings: EMPTY,
		});
	});

	it('keeps recovery state and exposes retry after a reset write failure', async () => {
		const plugin = fakePlugin(
			async () => ({ malformed: true }),
			async () => {
				throw new Error('read-only');
			},
		);

		await plugin.onload();
		await plugin.resetSettings();

		expect(plugin.getSettingsState()).toEqual({
			kind: 'recovery',
			diagnostic: { kind: 'write-failure' },
		});
	});
});
