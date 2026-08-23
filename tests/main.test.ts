import { beforeEach, describe, expect, it, vi } from 'vitest';

const obsidianPlatform = vi.hoisted(() => ({ isMobile: false }));

vi.mock('obsidian', () => ({
	Plugin: class {},
	Platform: obsidianPlatform,
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
	app: {
		vault: {
			adapter: { exists: () => Promise<boolean> };
			configDir: string;
		};
	};
	saveData: (data: unknown) => Promise<void>;
	addSettingTab: ReturnType<typeof vi.fn>;
};

function fakePlugin(
	loadData: () => Promise<unknown>,
	saveData: (data: unknown) => Promise<void> = async () => undefined,
): FakePlugin {
	const plugin = new DevRadarPlugin({} as never, {} as never) as FakePlugin;
	plugin.app = {
		vault: {
			adapter: { exists: async () => false },
			configDir: '.obsidian',
		},
	} as FakePlugin['app'];
	plugin.loadData = loadData;
	plugin.saveData = saveData;
	plugin.addSettingTab = vi.fn() as FakePlugin['addSettingTab'];
	return plugin;
}

describe('DevRadarPlugin settings lifecycle', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		obsidianPlatform.isMobile = false;
		vi.stubGlobal('window', { confirm: vi.fn(() => true) });
	});

	it('keeps persistence fail-closed on Mobile without reading data', async () => {
		obsidianPlatform.isMobile = true;
		let reads = 0;
		const saveData = vi.fn(async () => undefined);
		const plugin = fakePlugin(async () => {
			reads += 1;
			return EMPTY;
		}, saveData);

		await plugin.onload();
		await plugin.retrySettingsLoad();

		expect(reads).toBe(0);
		expect(saveData).not.toHaveBeenCalled();
		expect(plugin.getSettingsState()).toEqual({
			kind: 'recovery',
			diagnostic: { kind: 'unsupported-platform' },
		});
	});

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

	it('does not reset non-resettable recovery states', async () => {
		const cases = [
			{
				loadData: async () => {
					throw new Error('unavailable');
				},
				diagnostic: { kind: 'read-failure' },
			},
			{
				loadData: async () => ({
					schemaVersion: 2,
					followedPeople: [],
				}),
				diagnostic: {
					kind: 'validation',
					classification: 'future-schema',
				},
			},
			{
				loadData: async () => {
					const input = {};
					Object.defineProperty(input, 'schemaVersion', {
						enumerable: true,
						get: () => 1,
					});
					return input;
				},
				diagnostic: {
					kind: 'validation',
					classification: 'unclassifiable',
				},
			},
		];

		for (const scenario of cases) {
			const saveData = vi.fn(async () => undefined);
			const plugin = fakePlugin(scenario.loadData, saveData);
			await plugin.onload();
			await plugin.resetSettings();

			expect(plugin.getSettingsState()).toMatchObject({
				kind: 'recovery',
				diagnostic: scenario.diagnostic,
			});
			expect(saveData).not.toHaveBeenCalled();
		}
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

	it('recovers from malformed data on a valid retry without writing', async () => {
		let reads = 0;
		const saveData = vi.fn(async () => undefined);
		const plugin = fakePlugin(async () => {
			reads += 1;
			return reads === 1 ? { malformed: true } : EMPTY;
		}, saveData);

		await plugin.onload();
		await plugin.retrySettingsLoad();

		expect(plugin.getSettingsState()).toEqual({
			kind: 'ready',
			settings: EMPTY,
		});
		expect(saveData).not.toHaveBeenCalled();
	});

	it('updates recovery when a retry becomes unreadable', async () => {
		let reads = 0;
		const plugin = fakePlugin(async () => {
			reads += 1;
			if (reads === 1) return { malformed: true };
			throw new Error('unavailable');
		});

		await plugin.onload();
		await plugin.retrySettingsLoad();

		expect(plugin.getSettingsState()).toEqual({
			kind: 'recovery',
			diagnostic: { kind: 'read-failure' },
		});
	});

	it('coalesces Retry behind a pending Reset', async () => {
		let release!: () => void;
		const pendingSave = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reads = 0;
		const saveData = vi.fn(() => pendingSave);
		const plugin = fakePlugin(async () => {
			reads += 1;
			return { malformed: true };
		}, saveData);

		await plugin.onload();
		const reset = plugin.resetSettings();
		const retry = plugin.retrySettingsLoad();

		expect(plugin.isRecoveryActionPending()).toBe(true);
		expect(reads).toBe(1);
		release();
		await Promise.all([reset, retry]);

		expect(saveData).toHaveBeenCalledTimes(1);
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

	it('requires confirmation before resetting settings', async () => {
		const confirm = vi.fn<(message: string) => boolean>(() => false);
		vi.stubGlobal('window', { confirm });
		const saveData = vi.fn(async () => undefined);
		const plugin = fakePlugin(async () => ({ malformed: true }), saveData);

		await plugin.onload();
		await plugin.resetSettings();

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0]?.[0]).toContain(
			'followed-person configuration',
		);
		expect(confirm.mock.calls[0]?.[0]).toContain('synchronization history');
		expect(confirm.mock.calls[0]?.[0]).toContain('deduplication state');
		expect(confirm.mock.calls[0]?.[0]).toContain('provider-policy state');
		expect(confirm.mock.calls[0]?.[0]).toContain(
			'follow people again afterward',
		);
		expect(confirm.mock.calls[0]?.[0]).toContain(
			'existing notes untouched',
		);
		expect(confirm.mock.calls[0]?.[0]).toContain(
			'existing DevRadar activity remains',
		);
		expect(confirm.mock.calls[0]?.[0]).toContain('no GitHub requests');
		expect(confirm.mock.calls[0]?.[0]).toContain(
			'not delete, rename, move, or overwrite',
		);
		expect(saveData).not.toHaveBeenCalled();
		expect(plugin.getSettingsState().kind).toBe('recovery');
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
		await plugin.resetSettings();
		expect(plugin.getSettingsState()).toEqual({
			kind: 'recovery',
			diagnostic: { kind: 'write-failure' },
		});
	});

	it('keeps reset candidate validation failures non-resettable', async () => {
		const plugin = fakePlugin(async () => ({ malformed: true }));
		await plugin.onload();

		const persistence = (
			plugin as unknown as {
				persistence: {
					save(candidate: unknown): Promise<unknown>;
				};
			}
		).persistence;
		persistence.save = async () => ({
			kind: 'candidate-validation-failure',
			error: {
				code: 'invalid-type',
				path: '',
				message: 'candidate is invalid',
			},
		});

		await plugin.resetSettings();

		expect(plugin.getSettingsState()).toEqual({
			kind: 'recovery',
			diagnostic: { kind: 'internal-failure' },
		});
	});
});
