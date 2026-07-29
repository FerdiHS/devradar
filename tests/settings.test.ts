import { describe, expect, it } from 'vitest';
import { createSettings, type DevRadarSettings } from '../src/settings-data';

describe('createSettings', () => {
	it('returns a fresh settings object when storage is empty', () => {
		const stored = {} as DevRadarSettings;
		const settings = createSettings(stored);

		expect(settings).toEqual(stored);
		expect(settings).not.toBe(stored);
	});
});
