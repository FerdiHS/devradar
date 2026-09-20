import { describe, expect, it, vi } from 'vitest';
import {
	ObsidianSettingsPersistence,
	type PluginDataStore,
} from '../src/adapters/obsidian-settings';
import { ACTIVITY_FAMILIES } from '../src/domain/activity';
import {
	createEmptySettingsV2,
	migrateSettingsV1ToV2,
} from '../src/domain/settings';

const NOW = '2026-08-23T00:00:00.000Z';

function store(
	loadData: () => Promise<unknown>,
	hasData: () => Promise<boolean> = async () => false,
): PluginDataStore & { saved: unknown[] } {
	const saved: unknown[] = [];
	return {
		saved,
		loadData,
		hasData,
		saveData: vi.fn(async (data: unknown) => {
			saved.push(data);
		}),
	};
}

function validSettings(fromDate = '2026-08-23T00:00:00.000Z') {
	return {
		schemaVersion: 1,
		followedPeople: [
			{
				username: 'octocat',
				githubAccountId: '583231',
				notePath: 'People/octocat.md',
				trackingStart: { mode: 'from-date', at: fromDate },
				syncState: {
					seenEvents: [
						{ id: '123', createdAt: '2026-08-22T00:00:00Z' },
					],
					github: {},
				},
			},
		],
	};
}

function validSettingsV2() {
	return {
		schemaVersion: 2,
		followedPeople: [],
		enabledActivityFamilies: [...ACTIVITY_FAMILIES],
	};
}

describe('ObsidianSettingsPersistence', () => {
	it('maps Obsidian null absence to fresh empty settings without writing', async () => {
		const dataStore = store(async () => null);
		const persistence = new ObsidianSettingsPersistence(
			dataStore,
			() => NOW,
		);

		expect(await persistence.load()).toEqual({
			kind: 'loaded',
			settings: createEmptySettingsV2(),
			needsMigration: false,
		});
		expect(dataStore.saved).toEqual([]);
	});

	it('fails closed when present malformed data is returned as null', async () => {
		const dataStore = store(
			async () => null,
			async () => true,
		);
		const persistence = new ObsidianSettingsPersistence(
			dataStore,
			() => NOW,
		);

		expect(await persistence.load()).toMatchObject({
			kind: 'recovery',
			diagnostic: {
				kind: 'validation',
				classification: 'ordinary-malformed',
				error: { code: 'invalid-type', path: '' },
			},
		});
		expect(dataStore.saved).toEqual([]);
	});

	it('maps an empty object to fresh empty settings without writing', async () => {
		const dataStore = store(async () => ({}));
		const persistence = new ObsidianSettingsPersistence(
			dataStore,
			() => NOW,
		);

		expect(await persistence.load()).toEqual({
			kind: 'loaded',
			settings: createEmptySettingsV2(),
			needsMigration: true,
		});
		expect(dataStore.saved).toEqual([]);
	});

	it('loads valid populated settings as a fresh canonical value', async () => {
		const input = validSettings();
		const persistence = new ObsidianSettingsPersistence(
			store(async () => input),
			() => NOW,
		);

		const result = await persistence.load();

		expect(result).toEqual({
			kind: 'loaded',
			settings: migrateSettingsV1ToV2(input),
			needsMigration: true,
		});
		if (result.kind === 'loaded') expect(result.settings).not.toBe(input);
	});

	it('loads V2 settings without scheduling another migration write', async () => {
		const input = validSettingsV2();
		const dataStore = store(async () => input);
		const persistence = new ObsidianSettingsPersistence(
			dataStore,
			() => NOW,
		);

		expect(await persistence.load()).toEqual({
			kind: 'loaded',
			settings: input,
			needsMigration: false,
		});
		expect(dataStore.saved).toEqual([]);
	});

	it('uses a fresh current instant for each load', async () => {
		const input = validSettings('2026-08-23T01:00:00.000Z');
		const currentInstant = vi
			.fn<() => string>()
			.mockReturnValueOnce(NOW)
			.mockReturnValueOnce('2026-08-23T02:00:00.000Z');
		const persistence = new ObsidianSettingsPersistence(
			store(async () => input),
			currentInstant,
		);

		expect((await persistence.load()).kind).toBe('recovery');
		expect(await persistence.load()).toEqual({
			kind: 'loaded',
			settings: migrateSettingsV1ToV2(input),
			needsMigration: true,
		});
		expect(currentInstant).toHaveBeenCalledTimes(2);
	});

	it('returns a recovery result for a read failure', async () => {
		const persistence = new ObsidianSettingsPersistence(
			store(async () => {
				throw new Error('disk unavailable');
			}),
			() => NOW,
		);

		expect(await persistence.load()).toEqual({
			kind: 'recovery',
			diagnostic: { kind: 'read-failure' },
		});
	});

	it('classifies a future schema before validator error ordering can hide it', async () => {
		const persistence = new ObsidianSettingsPersistence(
			store(async () => ({ schemaVersion: 3, unknownField: true })),
			() => NOW,
		);

		expect(await persistence.load()).toMatchObject({
			kind: 'recovery',
			diagnostic: {
				kind: 'validation',
				classification: 'future-schema',
				error: {
					code: 'unsupported-schema-version',
					path: '/schemaVersion',
				},
			},
		});
	});

	it('keeps future-schema classification when schemaVersion is the first error', async () => {
		const persistence = new ObsidianSettingsPersistence(
			store(async () => ({ schemaVersion: 3 })),
			() => NOW,
		);

		expect(await persistence.load()).toMatchObject({
			kind: 'recovery',
			diagnostic: { kind: 'validation', classification: 'future-schema' },
		});
	});

	it('keeps future-schema classification before nested unsafe reflection', async () => {
		const person = {};
		Object.defineProperty(person, 'username', {
			enumerable: true,
			get: () => 'octocat',
		});
		const persistence = new ObsidianSettingsPersistence(
			store(async () => ({ schemaVersion: 3, followedPeople: [person] })),
			() => NOW,
		);

		expect(await persistence.load()).toMatchObject({
			kind: 'recovery',
			diagnostic: {
				kind: 'validation',
				classification: 'future-schema',
			},
		});
	});

	it('fails closed for an accessor-backed schemaVersion', async () => {
		const input = {};
		Object.defineProperty(input, 'schemaVersion', {
			enumerable: true,
			get: () => 2,
		});
		const persistence = new ObsidianSettingsPersistence(
			store(async () => input),
			() => NOW,
		);

		expect(await persistence.load()).toMatchObject({
			kind: 'recovery',
			diagnostic: {
				kind: 'validation',
				classification: 'unclassifiable',
			},
		});
	});

	it('fails closed when proxy reflection throws', async () => {
		const input = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error('reflection blocked');
				},
			},
		);
		const persistence = new ObsidianSettingsPersistence(
			store(async () => input),
			() => NOW,
		);

		expect(await persistence.load()).toMatchObject({
			kind: 'recovery',
			diagnostic: {
				kind: 'validation',
				classification: 'unclassifiable',
			},
		});
	});

	it('fails closed for an accessor nested in followedPeople', async () => {
		const person = {};
		Object.defineProperty(person, 'username', {
			enumerable: true,
			get: () => 'octocat',
		});
		const persistence = new ObsidianSettingsPersistence(
			store(async () => ({ schemaVersion: 1, followedPeople: [person] })),
			() => NOW,
		);

		expect(await persistence.load()).toMatchObject({
			kind: 'recovery',
			diagnostic: {
				kind: 'validation',
				classification: 'unclassifiable',
			},
		});
	});

	it('fails closed for a proxy nested in followedPeople', async () => {
		const person = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error('reflection blocked');
				},
			},
		);
		const persistence = new ObsidianSettingsPersistence(
			store(async () => ({ schemaVersion: 1, followedPeople: [person] })),
			() => NOW,
		);

		expect(await persistence.load()).toMatchObject({
			kind: 'recovery',
			diagnostic: {
				kind: 'validation',
				classification: 'unclassifiable',
			},
		});
	});

	it('fails closed for unsafe values in non-enumerable array slots', async () => {
		const person = {};
		Object.defineProperty(person, 'username', {
			enumerable: true,
			get: () => 'octocat',
		});
		const followedPeople: unknown[] = [];
		Object.defineProperty(followedPeople, '0', {
			configurable: true,
			value: person,
			writable: true,
		});
		const persistence = new ObsidianSettingsPersistence(
			store(async () => ({ schemaVersion: 1, followedPeople })),
			() => NOW,
		);

		expect(await persistence.load()).toMatchObject({
			kind: 'recovery',
			diagnostic: {
				kind: 'validation',
				classification: 'unclassifiable',
			},
		});
	});

	it('does not write when a candidate fails validation', async () => {
		const dataStore = store(async () => null);
		const persistence = new ObsidianSettingsPersistence(
			dataStore,
			() => NOW,
		);

		const result = await persistence.save({ schemaVersion: 2 });

		expect(result).toMatchObject({
			kind: 'candidate-validation-failure',
			error: { code: 'missing-field', path: '/followedPeople' },
		});
		expect(dataStore.saved).toEqual([]);
	});

	it('validates before writing and returns the canonical value', async () => {
		const dataStore = store(async () => null);
		const persistence = new ObsidianSettingsPersistence(
			dataStore,
			() => NOW,
		);
		const candidate = validSettingsV2();

		const result = await persistence.save(candidate);

		expect(result).toEqual({
			kind: 'saved',
			settings: validSettingsV2(),
		});
		expect(dataStore.saved).toEqual([validSettingsV2()]);
		expect(dataStore.saved[0]).not.toBe(candidate);
	});

	it('reports a write failure without exposing the thrown value', async () => {
		const dataStore = store(async () => null);
		dataStore.saveData = vi.fn(async () => {
			throw new Error('secret path');
		});
		const persistence = new ObsidianSettingsPersistence(
			dataStore,
			() => NOW,
		);

		expect(await persistence.save(validSettingsV2())).toEqual({
			kind: 'write-failure',
		});
	});
});
