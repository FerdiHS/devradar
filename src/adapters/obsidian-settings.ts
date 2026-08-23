import {
	type DevRadarSettingsV1,
	type SchemaV1ValidationError,
	validatePersistedSettingsV1,
} from '../domain/settings';

export type PluginDataStore = {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
};

export type SettingsRecoveryClassification =
	'ordinary-malformed' | 'future-schema' | 'unclassifiable';

export type SettingsRecoveryDiagnostic =
	| { readonly kind: 'read-failure' }
	| { readonly kind: 'write-failure' }
	| { readonly kind: 'internal-failure' }
	| {
			readonly kind: 'validation';
			readonly classification: SettingsRecoveryClassification;
			readonly error: SchemaV1ValidationError;
	  };

export type SettingsLoadResult =
	| { readonly kind: 'loaded'; readonly settings: DevRadarSettingsV1 }
	| {
			readonly kind: 'recovery';
			readonly diagnostic: SettingsRecoveryDiagnostic;
	  };

export type SettingsSaveResult =
	| { readonly kind: 'saved'; readonly settings: DevRadarSettingsV1 }
	| {
			readonly kind: 'candidate-validation-failure';
			readonly error: SchemaV1ValidationError;
	  }
	| { readonly kind: 'write-failure' }
	| { readonly kind: 'internal-failure' };

export function isResettableSettingsDiagnostic(
	diagnostic: SettingsRecoveryDiagnostic,
): boolean {
	return (
		diagnostic.kind === 'validation' &&
		diagnostic.classification === 'ordinary-malformed'
	);
}

export class ObsidianSettingsPersistence {
	constructor(
		private readonly dataStore: PluginDataStore,
		private readonly now: () => string,
	) {}

	async load(): Promise<SettingsLoadResult> {
		let raw: unknown;
		try {
			raw = await this.dataStore.loadData();
		} catch {
			return { kind: 'recovery', diagnostic: { kind: 'read-failure' } };
		}

		try {
			// Obsidian exposes an absent data.json as null and provides no presence bit.
			// A literal persisted JSON null is therefore indistinguishable here and is
			// intentionally treated as the same absence sentinel.
			const result = validatePersistedSettingsV1(
				raw === null ? undefined : raw,
				this.now(),
			);
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
		return 'ordinary-malformed';
	} catch {
		return 'unclassifiable';
	}
}
