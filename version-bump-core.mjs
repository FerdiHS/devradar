import { readFileSync, writeFileSync } from 'node:fs';

export function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new Error(`${path}: ${error.message}`);
	}
}

export function writeJsonIfChanged(path, value) {
	const next = `${JSON.stringify(value, null, '\t')}\n`;
	const current = readFileSync(path, 'utf8');

	if (current === next) {
		return false;
	}

	writeFileSync(path, next);
	return true;
}
