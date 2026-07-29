import { describe, expect, it } from 'vitest';
import { createSettings, DEFAULT_SETTINGS } from '../src/settings-data';

describe('createSettings', () => {
	it('returns a fresh settings object when storage is empty', () => {
		const settings = createSettings(undefined);

		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(settings).not.toBe(DEFAULT_SETTINGS);
	});
});
