import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.argv[2] ?? 'sync';

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, '\t')}\n`);
}

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
	manifest.version = targetVersion;
	versions[targetVersion] = minAppVersion;

	writeJson('manifest.json', manifest);
	writeJson('versions.json', versions);
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
