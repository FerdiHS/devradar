import { validatePersistedSettingsV1 } from '../domain/settings';
import type {
	SettingsLoadResult,
	SettingsPersistence,
	SettingsRecoveryClassification,
	SettingsSaveResult,
} from '../application/settings';

export type PluginDataStore = {
	loadData(): Promise<unknown>;
	hasData(): Promise<boolean>;
	saveData(data: unknown): Promise<void>;
};

export class ObsidianSettingsPersistence implements SettingsPersistence {
	constructor(
		private readonly dataStore: PluginDataStore,
		private readonly now: () => string,
	) {}

	async load(): Promise<SettingsLoadResult> {
		let raw: unknown;
		try {
			raw = await this.dataStore.loadData();
			if (raw === null || raw === undefined) {
				const hasData = await this.dataStore.hasData();
				if (!hasData) raw = undefined;
				else if (raw === undefined) raw = null;
			}
		} catch {
			return { kind: 'recovery', diagnostic: { kind: 'read-failure' } };
		}

		try {
			// Obsidian Desktop 1.13.7 returns null for absent, literal-null, and
			// malformed data.json; hasData() preserves the storage boundary.
			const result = validatePersistedSettingsV1(raw, this.now());
			if (result.ok) return { kind: 'loaded', settings: result.value };

			return {
				kind: 'recovery',
				diagnostic: {
					kind: 'validation',
					classification: classifyValidationFailure(raw),
					error: result.error,
				},
			};
		} catch {
			return {
				kind: 'recovery',
				diagnostic: { kind: 'internal-failure' },
			};
		}
	}

	async save(candidate: unknown): Promise<SettingsSaveResult> {
		let result: ReturnType<typeof validatePersistedSettingsV1>;
		try {
			result = validatePersistedSettingsV1(candidate, this.now());
		} catch {
			return { kind: 'internal-failure' };
		}
		if (!result.ok)
			return {
				kind: 'candidate-validation-failure',
				error: result.error,
			};

		try {
			await this.dataStore.saveData(result.value);
		} catch {
			return { kind: 'write-failure' };
		}
		return { kind: 'saved', settings: result.value };
	}
}

function classifyValidationFailure(
	raw: unknown,
): SettingsRecoveryClassification {
	try {
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
			return 'ordinary-malformed';
		const prototype = Reflect.getPrototypeOf(raw);
		if (prototype !== Object.prototype && prototype !== null)
			return 'unclassifiable';
		const descriptor = Object.getOwnPropertyDescriptor(
			raw,
			'schemaVersion',
		);
		if (!descriptor) return 'ordinary-malformed';
		if (!('value' in descriptor)) return 'unclassifiable';
		if (
			typeof descriptor.value === 'number' &&
			Number.isInteger(descriptor.value) &&
			descriptor.value > 1
		)
			return 'future-schema';
		if (hasUnsafeReflection(raw)) return 'unclassifiable';
		return 'ordinary-malformed';
	} catch {
		return 'unclassifiable';
	}
}

function hasUnsafeReflection(
	value: unknown,
	seen = new WeakSet<object>(),
): boolean {
	if (value === null || typeof value !== 'object') return false;
	if (seen.has(value)) return false;
	seen.add(value);

	try {
		Reflect.getPrototypeOf(value);
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !('value' in descriptor)) return true;
			if (hasUnsafeReflection(descriptor.value, seen)) return true;
		}
		return false;
	} catch {
		return true;
	}
}
