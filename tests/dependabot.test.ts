import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const dependabotConfig = parse(
	readFileSync(join(process.cwd(), '.github/dependabot.yml'), 'utf8'),
) as {
	version: number;
	updates: Array<{
		'package-ecosystem': string;
		directory: string;
		schedule: { interval: string };
		ignore?: Array<{
			'dependency-name': string;
			'update-types': string[];
			versions?: string[];
		}>;
	}>;
};

describe('Dependabot configuration', () => {
	it('defers only incompatible major dependency updates', () => {
		expect(dependabotConfig.version).toBe(2);
		const npmUpdaters = dependabotConfig.updates.filter(
			(update) =>
				update['package-ecosystem'] === 'npm' &&
				update.directory === '/',
		);
		expect(npmUpdaters).toHaveLength(1);
		const [npmUpdater] = npmUpdaters;
		expect(npmUpdater).toMatchObject({
			'package-ecosystem': 'npm',
			directory: '/',
			schedule: { interval: 'weekly' },
		});

		const ignoredDependencies = npmUpdater?.ignore ?? [];
		const expectedDependencyNames = ['eslint', '@eslint/js', 'lint-staged'];
		expect(
			ignoredDependencies
				.map((ignore) => ignore['dependency-name'])
				.sort(),
		).toEqual([...expectedDependencyNames].sort());
		for (const dependencyName of expectedDependencyNames) {
			const ignoredDependency = ignoredDependencies.find(
				(ignore) => ignore['dependency-name'] === dependencyName,
			);

			expect(ignoredDependency).toBeDefined();
			expect(ignoredDependency?.['update-types']).toEqual([
				'version-update:semver-major',
			]);
			expect(ignoredDependency?.versions).toBeUndefined();
		}
	});
});
