import { readJson, writeJsonIfChanged } from './version-bump-core.mjs';

const mode = process.argv[2] ?? 'sync';

const packageJson = readJson('package.json');
const manifest = readJson('manifest.json');
const versions = readJson('versions.json');
const targetVersion = packageJson.version;
const minAppVersion = manifest.minAppVersion;

if (!targetVersion) {
	throw new Error('package.json version is required');
}

if (!minAppVersion) {
	throw new Error('manifest.json minAppVersion is required');
}

if (mode === 'sync') {
	const nextManifest = {
		...manifest,
		version: targetVersion,
	};
	const nextVersions = {
		...versions,
		[targetVersion]: minAppVersion,
	};

	writeJsonIfChanged('manifest.json', nextManifest);
	writeJsonIfChanged('versions.json', nextVersions);
	process.exit(0);
}

if (mode === 'check') {
	const errors = [];

	if (manifest.version !== targetVersion) {
		errors.push(
			`manifest.json version ${manifest.version} does not match package.json version ${targetVersion}`,
		);
	}

	if (versions[targetVersion] !== minAppVersion) {
		errors.push(
			`versions.json entry for ${targetVersion} must be ${minAppVersion}`,
		);
	}

	if (errors.length > 0) {
		throw new Error(errors.join('\n'));
	}

	process.exit(0);
}

throw new Error(`Unknown mode: ${mode}`);
