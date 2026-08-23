import { describe, expect, it, vi } from 'vitest';
import {
	ObsidianSettingsPersistence,
	type PluginDataStore,
} from '../src/adapters/obsidian-settings';
import { createEmptySettingsV1 } from '../src/domain/settings';

const NOW = '2026-08-23T00:00:00.000Z';

function store(loadData: () => Promise<unknown>): PluginDataStore & {
	saved: unknown[];
} {
	const saved: unknown[] = [];
	return {
		saved,
		loadData,
		saveData: vi.fn(async (data: unknown) => {
			saved.push(data);
		}),
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
			settings: createEmptySettingsV1(),
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
			settings: createEmptySettingsV1(),
		});
		expect(dataStore.saved).toEqual([]);
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
			store(async () => ({ schemaVersion: 2, unknownField: true })),
			() => NOW,
		);

		expect(await persistence.load()).toMatchObject({
			kind: 'recovery',
			diagnostic: {
				kind: 'validation',
				classification: 'future-schema',
				error: { code: 'unexpected-field', path: '/unknownField' },
			},
		});
	});

	it('keeps future-schema classification when schemaVersion is the first error', async () => {
		const persistence = new ObsidianSettingsPersistence(
			store(async () => ({ schemaVersion: 2 })),
			() => NOW,
		);

		expect(await persistence.load()).toMatchObject({
			kind: 'recovery',
			diagnostic: { kind: 'validation', classification: 'future-schema' },
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

		const result = await persistence.save({ schemaVersion: 1 });

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
		const candidate = { schemaVersion: 1, followedPeople: [] };

		const result = await persistence.save(candidate);

		expect(result).toEqual({
			kind: 'saved',
			settings: createEmptySettingsV1(),
		});
		expect(dataStore.saved).toEqual([createEmptySettingsV1()]);
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

		expect(await persistence.save(createEmptySettingsV1())).toEqual({
			kind: 'write-failure',
		});
	});
});
