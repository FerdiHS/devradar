import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = join(process.cwd(), 'version-bump.mjs');

function run(
	mode: 'sync' | 'check',
	cwd: string,
) {
	return execFileSync(process.execPath, [scriptPath, mode], {
		cwd,
		stdio: 'pipe',
	});
}

function makeFixture({
	packageVersion = '0.0.2',
	manifestVersion = '0.0.1',
	versions = { '0.0.1': '1.0.0' },
}: {
	packageVersion?: string;
	manifestVersion?: string;
	versions?: Record<string, string>;
} = {}) {
	const cwd = mkdtempSync(join(tmpdir(), 'devradar-version-bump-'));

	writeFileSync(
		join(cwd, 'package.json'),
		JSON.stringify({ version: packageVersion }, null, '\t'),
	);
	writeFileSync(
		join(cwd, 'manifest.json'),
		JSON.stringify(
			{
				minAppVersion: '1.0.0',
				version: manifestVersion,
			},
			null,
			'\t',
		),
	);
	writeFileSync(
		join(cwd, 'versions.json'),
		JSON.stringify(versions, null, '\t'),
	);

	return cwd;
}

function readJson<T>(cwd: string, fileName: string): T {
	return JSON.parse(readFileSync(join(cwd, fileName), 'utf8')) as T;
}

describe('version-bump CLI', () => {
	it('sync updates manifest.json and adds a matching versions.json entry', () => {
		const cwd = makeFixture();

		run('sync', cwd);

		expect(
			readJson<{ version: string }>(cwd, 'manifest.json').version,
		).toBe('0.0.2');
		expect(readJson<Record<string, string>>(cwd, 'versions.json')).toEqual({
			'0.0.1': '1.0.0',
			'0.0.2': '1.0.0',
		});
	});

	it('check passes when release metadata is aligned', () => {
		const cwd = makeFixture({
			manifestVersion: '0.0.2',
			versions: {
				'0.0.1': '1.0.0',
				'0.0.2': '1.0.0',
			},
		});

		expect(() => run('check', cwd)).not.toThrow();
	});

	it('check fails when manifest.json is out of sync', () => {
		const cwd = makeFixture({
			manifestVersion: '0.0.1',
			versions: {
				'0.0.2': '1.0.0',
			},
		});

		expect(() => run('check', cwd)).toThrow(/manifest\.json version/);
	});

	it('check fails when versions.json is out of sync', () => {
		const cwd = makeFixture({
			manifestVersion: '0.0.2',
			versions: {
				'0.0.2': '1.1.0',
			},
		});

		expect(() => run('check', cwd)).toThrow(/versions\.json entry/);
	});
});
