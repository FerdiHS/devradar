import { describe, expect, it } from 'vitest';
import { applyVersionUpdate } from '../version-bump.mjs';

describe('applyVersionUpdate', () => {
	it('updates the manifest and version map for a new release version', () => {
		expect(
			applyVersionUpdate(
				{
					minAppVersion: '1.6.0',
					version: '0.0.1',
				},
				{
					'0.0.1': '1.6.0',
				},
				'0.0.2',
			),
		).toEqual({
			manifest: {
				minAppVersion: '1.6.0',
				version: '0.0.2',
			},
			versions: {
				'0.0.1': '1.6.0',
				'0.0.2': '1.6.0',
			},
		});
	});
});
