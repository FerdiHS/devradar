export type VersionBumpManifest = {
	minAppVersion: string;
	version: string;
};

export type VersionBumpVersions = Record<string, string>;

export declare function applyVersionUpdate(
	manifest: VersionBumpManifest,
	versions: VersionBumpVersions,
	targetVersion: string,
): {
	manifest: VersionBumpManifest;
	versions: VersionBumpVersions;
};
