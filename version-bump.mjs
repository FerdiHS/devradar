import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function applyVersionUpdate(manifest, versions, targetVersion) {
	const nextManifest = {
		...manifest,
		version: targetVersion,
	};

	const nextVersions = { ...versions };
	if (!(targetVersion in nextVersions)) {
		nextVersions[targetVersion] = manifest.minAppVersion;
	}

	return {
		manifest: nextManifest,
		versions: nextVersions,
	};
}

function main() {
	const targetVersion = process.env.npm_package_version;
	if (!targetVersion) {
		throw new Error('npm_package_version is required');
	}

	const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
	const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
	const updated = applyVersionUpdate(manifest, versions, targetVersion);

	writeFileSync(
		'manifest.json',
		JSON.stringify(updated.manifest, null, '\t'),
	);
	writeFileSync(
		'versions.json',
		JSON.stringify(updated.versions, null, '\t'),
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
