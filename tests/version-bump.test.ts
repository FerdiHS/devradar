import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeJsonIfChanged } from '../version-bump-core.mjs';

const scriptPath = join(process.cwd(), 'version-bump.mjs');

function run(mode: 'sync' | 'check', cwd: string) {
	return execFileSync(process.execPath, [scriptPath, mode], {
		cwd,
		stdio: 'pipe',
	});
}

function makeFixture({
	manifestVersion = '0.0.1',
	versions = { '0.0.1': '1.0.0' },
}: {
	manifestVersion?: string;
	versions?: Record<string, string>;
} = {}) {
	const cwd = mkdtempSync(join(tmpdir(), 'devradar-version-bump-'));

	writeFileSync(
		join(cwd, 'package.json'),
		JSON.stringify({ version: '0.0.2' }, null, '\t'),
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
	it('writeJsonIfChanged returns false when the JSON is already identical', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'devradar-version-bump-write-'));
		const path = join(cwd, 'manifest.json');

		writeFileSync(path, '{\n\t"version": "0.0.2"\n}\n');

		expect(writeJsonIfChanged(path, { version: '0.0.2' })).toBe(false);
		expect(readFileSync(path, 'utf8')).toBe('{\n\t"version": "0.0.2"\n}\n');
	});

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

	it('check fails when versions.json is missing the current version entry', () => {
		const cwd = makeFixture({
			manifestVersion: '0.0.2',
			versions: { '0.0.1': '1.0.0' },
		});

		expect(() => run('check', cwd)).toThrow(
			/versions\.json entry for 0\.0\.2 must be 1\.0\.0/,
		);
	});

	it.each(['manifest.json', 'versions.json'])(
		'fails with a file-scoped error for malformed %s',
		(fileName) => {
			const cwd = makeFixture({
				manifestVersion: '0.0.2',
				versions: { '0.0.2': '1.0.0' },
			});
			writeFileSync(join(cwd, fileName), '{');

			expect(() => run('check', cwd)).toThrow(new RegExp(`${fileName}:`));
		},
	);

	it('fails on unsupported mode', () => {
		const cwd = makeFixture();

		expect(() =>
			execFileSync(process.execPath, [scriptPath, 'bogus'], {
				cwd,
				stdio: 'pipe',
			}),
		).toThrow(/Unknown mode: bogus/);
	});
});
