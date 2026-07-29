import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('version-bump.mjs', () => {
	it('updates manifest and versions.json for a new release version', () => {
		const dir = mkdtempSync(join(tmpdir(), 'devradar-version-bump-'));
		const manifest = {
			minAppVersion: '1.6.0',
			version: '0.0.1',
		};
		const versions = {
			'0.0.1': '1.6.0',
		};

		writeFileSync(
			join(dir, 'manifest.json'),
			JSON.stringify(manifest, null, '\t'),
		);
		writeFileSync(
			join(dir, 'versions.json'),
			JSON.stringify(versions, null, '\t'),
		);

		const result = spawnSync(
			process.execPath,
			[join(process.cwd(), 'version-bump.mjs')],
			{
				cwd: dir,
				env: {
					...process.env,
					npm_package_version: '0.0.2',
				},
				encoding: 'utf8',
			},
		);

		expect(result.status).toBe(0);
		expect(
			JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')),
		).toEqual({
			minAppVersion: '1.6.0',
			version: '0.0.2',
		});
		expect(
			JSON.parse(readFileSync(join(dir, 'versions.json'), 'utf8')),
		).toEqual({
			'0.0.1': '1.6.0',
			'0.0.2': '1.6.0',
		});
	});
});
