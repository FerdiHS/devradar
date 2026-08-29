import { beforeEach, describe, expect, it, vi } from 'vitest';

const obsidianPlatform = vi.hoisted(() => ({
	isMobile: false,
	isMobileApp: false,
}));
const obsidianNotice = vi.hoisted(() => vi.fn());
const modalState = vi.hoisted(() => ({
	instances: [] as Array<{
		getItems: () => unknown[];
		onChooseItem: (item: unknown) => void;
		onClose: () => void;
		open: () => void;
	}>,
}));

vi.mock('obsidian', () => ({
	Plugin: class {},
	normalizePath: (path: string) => path,
	Platform: obsidianPlatform,
	Notice: obsidianNotice,
	FuzzySuggestModal: class {
		constructor(_app: unknown) {
			modalState.instances.push(this);
		}
		getItems(): unknown[] {
			return [];
		}
		onChooseItem(_item: unknown): void {}
		onClose(): void {}
		open(): void {}
	},
	PluginSettingTab: class {
		constructor(
			readonly app: unknown,
			readonly plugin: unknown,
		) {}
	},
}));

import DevRadarPlugin from '../src/main';

const EMPTY = { schemaVersion: 1, followedPeople: [] };
const FOLLOWED = {
	schemaVersion: 1,
	followedPeople: [
		{
			username: 'octocat',
			githubAccountId: '583231',
			notePath: 'People/octocat.md',
			trackingStart: { mode: 'available-recent' },
			syncState: { seenEvents: [], github: {} },
		},
	],
};

type RegisteredCommand = { callback?: () => unknown };

function syncOneCommand(plugin: FakePlugin): RegisteredCommand {
	const calls = plugin.addCommand.mock.calls as unknown as Array<
		[RegisteredCommand]
	>;
	const command = calls[0]?.[0];
	if (!command?.callback)
		throw new Error('Sync One command was not registered');
	return command;
}

function pickerInstance(): (typeof modalState.instances)[number] {
	const picker = modalState.instances[0];
	if (!picker) throw new Error('Sync One picker was not opened');
	return picker;
}

type FakePlugin = DevRadarPlugin & {
	loadData: () => Promise<unknown>;
	app: {
		vault: {
			adapter: { exists: () => Promise<boolean> };
		};
	};
	manifest: { id: string; dir?: string };
	saveData: (data: unknown) => Promise<void>;
	addSettingTab: ReturnType<typeof vi.fn>;
	addCommand: ReturnType<typeof vi.fn>;
};

type FakePluginOptions = {
	exists?: () => Promise<boolean>;
	pluginDir?: string;
};

function fakePlugin(
	loadData: () => Promise<unknown>,
	saveData: (data: unknown) => Promise<void> = async () => undefined,
	options: FakePluginOptions = {},
): FakePlugin {
	const plugin = new DevRadarPlugin({} as never, {} as never) as FakePlugin;
	plugin.app = {
		vault: {
			adapter: { exists: options.exists ?? (async () => false) },
		},
	} as FakePlugin['app'];
	plugin.manifest = {
		id: 'devradar',
		dir: options.pluginDir ?? '.test-config/plugins/devradar-local',
	} as FakePlugin['manifest'];
	plugin.loadData = loadData;
	plugin.saveData = saveData;
	plugin.addSettingTab = vi.fn() as FakePlugin['addSettingTab'];
	plugin.addCommand = vi.fn() as FakePlugin['addCommand'];
	return plugin;
}

describe('DevRadarPlugin settings lifecycle', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		obsidianPlatform.isMobile = false;
		obsidianPlatform.isMobileApp = false;
		obsidianNotice.mockReset();
		modalState.instances.length = 0;
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
		const result = await plugin.follow({
			username: 'octocat',
			notePath: 'People/octocat.md',
			trackingStart: { mode: 'now' },
		});

		expect(reads).toBe(0);
		expect(saveData).not.toHaveBeenCalled();
		expect(result).toEqual({
			kind: 'failed',
			reason: 'settings-not-ready',
		});
		expect(plugin.getSettingsState()).toEqual({
			kind: 'recovery',
			diagnostic: { kind: 'unsupported-platform' },
		});
	});

	it('checks the actual plugin directory for persisted-data presence', async () => {
		const exists = vi.fn(async () => true);
		const plugin = fakePlugin(
			async () => null,
			async () => undefined,
			{
				exists,
				pluginDir: '.custom/plugins/devradar-local',
			},
		);

		await plugin.onload();

		expect(exists).toHaveBeenCalledWith(
			'.custom/plugins/devradar-local/data.json',
		);
		expect(plugin.getSettingsState()).toMatchObject({
			kind: 'recovery',
			diagnostic: {
				kind: 'validation',
				classification: 'ordinary-malformed',
			},
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

describe('Sync One command wiring', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		obsidianPlatform.isMobile = false;
		obsidianPlatform.isMobileApp = false;
		obsidianNotice.mockReset();
		modalState.instances.length = 0;
		vi.stubGlobal('window', { confirm: vi.fn(() => true) });
	});

	it('fails closed on Mobile before opening the picker', async () => {
		obsidianPlatform.isMobileApp = true;
		const plugin = fakePlugin(async () => EMPTY);

		await plugin.onload();
		await syncOneCommand(plugin).callback?.();

		expect(modalState.instances).toHaveLength(0);
		expect(obsidianNotice).toHaveBeenCalledWith(
			'Sync one is unavailable on mobile.',
		);
	});

	it('reports when there are no followed people', async () => {
		const plugin = fakePlugin(async () => EMPTY);

		await plugin.onload();
		await syncOneCommand(plugin).callback?.();

		expect(modalState.instances).toHaveLength(0);
		expect(obsidianNotice).toHaveBeenCalledWith(
			'No followed people are available to sync.',
		);
	});

	it('passes only the durable account ID after picker selection', async () => {
		const plugin = fakePlugin(async () => FOLLOWED);
		await plugin.onload();
		const application = (
			plugin as unknown as {
				syncOneApplication: {
					syncOne: (selection: unknown) => Promise<unknown>;
				};
			}
		).syncOneApplication;
		const syncOne = vi
			.spyOn(application, 'syncOne')
			.mockResolvedValue({ kind: 'unchanged' });

		await syncOneCommand(plugin).callback?.();
		const picker = pickerInstance();
		picker.onChooseItem({
			username: 'octocat',
			githubAccountId: '583231',
		});
		await Promise.resolve();

		expect(syncOne).toHaveBeenCalledWith({ githubAccountId: '583231' });
	});

	it('does not invoke Sync One when the picker is cancelled', async () => {
		const plugin = fakePlugin(async () => FOLLOWED);
		await plugin.onload();
		const application = (
			plugin as unknown as {
				syncOneApplication: {
					syncOne: (selection: unknown) => Promise<unknown>;
				};
			}
		).syncOneApplication;
		const syncOne = vi
			.spyOn(application, 'syncOne')
			.mockResolvedValue({ kind: 'unchanged' });

		await syncOneCommand(plugin).callback?.();
		pickerInstance().onClose();
		await Promise.resolve();

		expect(syncOne).not.toHaveBeenCalled();
		expect(obsidianNotice).not.toHaveBeenCalled();
	});

	it('coalesces command activation while picker or Sync One is pending', async () => {
		const plugin = fakePlugin(async () => FOLLOWED);
		await plugin.onload();
		const application = (
			plugin as unknown as {
				syncOneApplication: {
					syncOne: (selection: unknown) => Promise<unknown>;
				};
			}
		).syncOneApplication;
		let release!: (value: { kind: 'unchanged' }) => void;
		const pending = new Promise<{ kind: 'unchanged' }>((resolve) => {
			release = resolve;
		});
		const syncOne = vi
			.spyOn(application, 'syncOne')
			.mockReturnValue(pending);

		await syncOneCommand(plugin).callback?.();
		await syncOneCommand(plugin).callback?.();
		expect(modalState.instances).toHaveLength(1);
		expect(syncOne).not.toHaveBeenCalled();
		expect(obsidianNotice).toHaveBeenCalledWith(
			'Sync one is already in progress.',
		);

		pickerInstance().onChooseItem({
			username: 'octocat',
			githubAccountId: '583231',
		});
		await Promise.resolve();
		await syncOneCommand(plugin).callback?.();
		expect(syncOne).toHaveBeenCalledTimes(1);
		expect(modalState.instances).toHaveLength(1);

		release({ kind: 'unchanged' });
		await pending;
		await Promise.resolve();
	});

	it('keeps a selection alive when close precedes the selection callback', async () => {
		const plugin = fakePlugin(async () => FOLLOWED);
		await plugin.onload();
		const application = (
			plugin as unknown as {
				syncOneApplication: {
					syncOne: (selection: unknown) => Promise<unknown>;
				};
			}
		).syncOneApplication;
		let release!: (value: { kind: 'unchanged' }) => void;
		const pending = new Promise<{ kind: 'unchanged' }>((resolve) => {
			release = resolve;
		});
		const syncOne = vi
			.spyOn(application, 'syncOne')
			.mockReturnValue(pending);

		await syncOneCommand(plugin).callback?.();
		const picker = pickerInstance();
		picker.onClose();
		picker.onChooseItem({
			username: 'octocat',
			githubAccountId: '583231',
		});
		await Promise.resolve();
		await syncOneCommand(plugin).callback?.();
		expect(syncOne).toHaveBeenCalledTimes(1);
		expect(modalState.instances).toHaveLength(1);

		release({ kind: 'unchanged' });
		await pending;
		await Promise.resolve();
	});

	it('handles an application rejection without an unhandled promise', async () => {
		const plugin = fakePlugin(async () => FOLLOWED);
		await plugin.onload();
		const application = (
			plugin as unknown as {
				syncOneApplication: {
					syncOne: (selection: unknown) => Promise<unknown>;
				};
			}
		).syncOneApplication;
		vi.spyOn(application, 'syncOne').mockRejectedValue(new Error('boom'));

		await syncOneCommand(plugin).callback?.();
		pickerInstance().onChooseItem({
			username: 'octocat',
			githubAccountId: '583231',
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(obsidianNotice).toHaveBeenCalledWith(
			'Sync one failed unexpectedly.',
		);
	});
});
