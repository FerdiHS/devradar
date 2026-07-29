export type DevRadarSettings = Record<string, never>;

export function createSettings(
	raw: Partial<DevRadarSettings> | null | undefined,
): DevRadarSettings {
	return { ...(raw ?? {}) } as DevRadarSettings;
}
