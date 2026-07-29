export type DevRadarSettings = Record<string, never>;

export const DEFAULT_SETTINGS: DevRadarSettings = {};

export function createSettings(
	raw: Partial<DevRadarSettings> | null | undefined,
): DevRadarSettings {
	return Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
}
