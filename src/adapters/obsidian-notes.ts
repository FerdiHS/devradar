import {
	requireApiVersion,
	TFile,
	TFolder,
	type FileManager,
	type Vault,
} from 'obsidian';
import { canonicalizeDraftNotePath } from '../domain/settings';
import {
	renderNewPersonNote,
	type PersonIdentity,
	type PersonNoteFailure,
} from '../domain/person-note';
import {
	inspectAssociationProperties,
	validateAssociationPropertyObject,
} from '../domain/person-note-properties';
import type {
	AssociationTransform,
	CurrentContentTransform,
	NotePersistence,
	NotePersistenceError,
	NotePersistenceFailure,
	NotePreparationResult,
	NoteProcessResult,
	NoteReadResult,
} from '../application/note-persistence';

type ValidatedPath = { readonly ok: true; readonly path: string };
type InvalidPath = {
	readonly ok: false;
	readonly error: NotePersistenceFailure;
};

type Target =
	| { readonly kind: 'file'; readonly file: TFile }
	| { readonly kind: 'missing' }
	| { readonly kind: 'non-file' }
	| { readonly kind: 'lookup-failure' };

type AssociationDecision =
	| { readonly kind: 'reuse' }
	| { readonly kind: 'initialize'; readonly markdown: string }
	| { readonly kind: 'reject'; readonly error: PersonNoteFailure }
	| { readonly kind: 'throw' };

type ProcessDecision<TTransformError> =
	| {
			readonly kind: 'replace';
			readonly markdown: string;
			readonly currentMarkdown: string;
	  }
	| { readonly kind: 'reject'; readonly error: TTransformError }
	| { readonly kind: 'throw' };

export function createObsidianNotePersistence(
	vault: Pick<
		Vault,
		'getAbstractFileByPath' | 'read' | 'create' | 'createFolder' | 'process'
	>,
	fileManager: Pick<FileManager, 'processFrontMatter'>,
): NotePersistence {
	return {
		read: (path) => read(vault, path),
		prepareAssociation: (path, identity, transform) =>
			prepareAssociation(vault, fileManager, path, identity, transform),
		process: (path, transform) => process(vault, path, transform),
	};
}

async function read(
	vault: Pick<Vault, 'getAbstractFileByPath' | 'read'>,
	path: string,
): Promise<NoteReadResult> {
	const validated = validatePath(path);
	if (!validated.ok) return failed(validated.error);
	const target = resolveTarget(vault, validated.path);
	if (target.kind === 'missing') return failed({ kind: 'missing-target' });
	if (target.kind === 'non-file') return failed({ kind: 'non-file-target' });
	if (target.kind === 'lookup-failure')
		return failed({ kind: 'read-failure' });
	try {
		return { kind: 'read', markdown: await vault.read(target.file) };
	} catch {
		return failed({ kind: 'read-failure' });
	}
}

async function prepareAssociation(
	vault: Pick<
		Vault,
		'getAbstractFileByPath' | 'read' | 'create' | 'createFolder' | 'process'
	>,
	fileManager: Pick<FileManager, 'processFrontMatter'>,
	path: string,
	identity: PersonIdentity,
	transform: AssociationTransform,
): Promise<NotePreparationResult> {
	const validated = validatePath(path);
	if (!validated.ok) return failed<PersonNoteFailure>(validated.error);
	const target = resolveTarget(vault, validated.path);
	if (target.kind === 'missing') {
		const rendered = renderNewPersonNote(identity);
		if (!rendered.ok)
			return failed({
				kind: 'transform-rejection',
				error: rendered.error,
			});
		try {
			await ensureParentFolders(vault, validated.path);
			await vault.create(validated.path, rendered.value);
			return { kind: 'created' };
		} catch {
			return failed({ kind: 'create-failure' });
		}
	}
	if (target.kind === 'non-file') return failed({ kind: 'non-file-target' });
	if (target.kind === 'lookup-failure')
		return failed({ kind: 'process-failure' });

	let currentMarkdown: string;
	try {
		currentMarkdown = await vault.read(target.file);
	} catch {
		return failed({ kind: 'process-failure' });
	}
	let initialTransform: ReturnType<AssociationTransform>;
	try {
		initialTransform = transform(currentMarkdown);
	} catch {
		return failed({ kind: 'transform-failure' });
	}
	if (initialTransform.kind === 'reject')
		return failed({
			kind: 'transform-rejection',
			error: initialTransform.error,
		});
	if (initialTransform.kind === 'initialize') {
		let needsProperties = false;
		try {
			const currentBeforeProperties = await vault.read(target.file);
			const result = transform(currentBeforeProperties);
			if (result.kind === 'reject')
				return failed({
					kind: 'transform-rejection',
					error: result.error,
				});
			if (result.kind === 'initialize') {
				const properties = inspectAssociationProperties(
					currentBeforeProperties,
					identity,
				);
				if (!properties.ok)
					return failed({
						kind: 'transform-rejection',
						error: properties.error,
					});
				needsProperties = properties.value.missing.length > 0;
			}
		} catch {
			return failed({ kind: 'process-failure' });
		}
		if (needsProperties)
			if (!requireApiVersion('1.4.4'))
				return failed({ kind: 'process-failure' });
		if (needsProperties)
			try {
				// The runtime guard above protects older declared-compatible versions.
				await fileManager['processFrontMatter'](
					target.file,
					(frontmatter: Record<string, unknown>) => {
						const validatedProperties =
							validateAssociationPropertyObject(
								frontmatter,
								identity,
							);
						if (!validatedProperties.ok)
							throw new FrontmatterError(
								validatedProperties.error,
							);
						for (const property of validatedProperties.value
							.missing) {
							frontmatter[property] =
								property === 'devradarGithubId'
									? identity.githubId
									: identity.username;
						}
					},
				);
			} catch (error) {
				if (error instanceof FrontmatterError)
					return failed({
						kind: 'transform-rejection',
						error: error.failure,
					});
				return failed({ kind: 'process-failure' });
			}
	}

	let decision: AssociationDecision | undefined;
	try {
		if (requireApiVersion('1.1.0')) {
			await vault.process(target.file, (currentMarkdown) => {
				try {
					const result = transform(currentMarkdown);
					if (result.kind === 'reject') {
						decision = { kind: 'reject', error: result.error };
						return currentMarkdown;
					}
					if (result.kind === 'reuse') {
						decision = { kind: 'reuse' };
						return currentMarkdown;
					}
					const properties = inspectAssociationProperties(
						currentMarkdown,
						identity,
					);
					if (!properties.ok || properties.value.missing.length > 0) {
						decision = {
							kind: 'reject',
							error: properties.ok
								? {
										kind: 'frontmatter-failure',
										reason: 'missing-property',
									}
								: properties.error,
						};
						return currentMarkdown;
					}
					decision = {
						kind: 'initialize',
						markdown: result.markdown,
					};
					return result.markdown;
				} catch {
					decision = { kind: 'throw' };
					return currentMarkdown;
				}
			});
		} else return failed({ kind: 'process-failure' });
	} catch {
		return failed({ kind: 'process-failure' });
	}
	if (!decision || decision.kind === 'throw')
		return failed({ kind: 'transform-failure' });
	if (decision.kind === 'reject')
		return failed({
			kind: 'transform-rejection',
			error: decision.error,
		});
	return decision.kind === 'reuse'
		? { kind: 'reused' }
		: { kind: 'initialized' };
}

class FrontmatterError extends Error {
	constructor(readonly failure: PersonNoteFailure) {
		super('frontmatter validation failed');
	}
}

async function ensureParentFolders(
	vault: Pick<Vault, 'getAbstractFileByPath' | 'createFolder'>,
	path: string,
): Promise<void> {
	const parts = path.split('/');
	for (let index = 1; index < parts.length; index += 1) {
		const parent = parts.slice(0, index).join('/');
		let target: unknown;
		try {
			target = vault.getAbstractFileByPath(parent);
		} catch {
			throw new Error('parent lookup failed');
		}
		if (target) {
			if (!(target instanceof TFolder))
				throw new Error('parent is not a folder');
			continue;
		}
		if (!requireApiVersion('1.4.0'))
			throw new Error('folder API unavailable');
		// The runtime guard above protects older declared-compatible versions.
		await vault['createFolder'](parent);
	}
}

async function process<TTransformError>(
	vault: Pick<Vault, 'getAbstractFileByPath' | 'process'>,
	path: string,
	transform: CurrentContentTransform<TTransformError>,
): Promise<NoteProcessResult<TTransformError>> {
	const validated = validatePath(path);
	if (!validated.ok) return failed<TTransformError>(validated.error);
	const target = resolveTarget(vault, validated.path);
	if (target.kind === 'missing') return failed({ kind: 'missing-target' });
	if (target.kind === 'non-file') return failed({ kind: 'non-file-target' });
	if (target.kind === 'lookup-failure')
		return failed({ kind: 'process-failure' });

	let decision: ProcessDecision<TTransformError> | undefined;
	try {
		if (requireApiVersion('1.1.0')) {
			await vault.process(target.file, (currentMarkdown) => {
				try {
					const result = transform(currentMarkdown);
					if (result.kind === 'reject') {
						decision = { kind: 'reject', error: result.error };
						return currentMarkdown;
					}
					decision = {
						kind: 'replace',
						markdown: result.markdown,
						currentMarkdown,
					};
					return result.markdown;
				} catch {
					decision = { kind: 'throw' };
					return currentMarkdown;
				}
			});
		} else return failed<TTransformError>({ kind: 'process-failure' });
	} catch {
		return failed({ kind: 'process-failure' });
	}
	if (!decision || decision.kind === 'throw')
		return failed({ kind: 'transform-failure' });
	if (decision.kind === 'reject')
		return failed({ kind: 'transform-rejection', error: decision.error });
	return {
		kind:
			decision.markdown === decision.currentMarkdown
				? 'unchanged'
				: 'changed',
	};
}

function resolveTarget(
	vault: Pick<Vault, 'getAbstractFileByPath'>,
	path: string,
): Target {
	try {
		const target = vault.getAbstractFileByPath(path);
		if (!target) return { kind: 'missing' };
		return target instanceof TFile
			? { kind: 'file', file: target }
			: { kind: 'non-file' };
	} catch {
		return { kind: 'lookup-failure' };
	}
}

function validatePath(input: unknown): ValidatedPath | InvalidPath {
	const canonical = canonicalizeDraftNotePath(input);
	if (!canonical.ok)
		return {
			ok: false,
			error: {
				kind: 'invalid-path',
				reason: isUnsafePath(input) ? 'unsafe' : 'invalid',
			},
		};
	if (canonical.value !== input)
		return {
			ok: false,
			error: { kind: 'invalid-path', reason: 'non-canonical' },
		};
	return { ok: true, path: canonical.value };
}

function isUnsafePath(input: unknown): boolean {
	if (typeof input !== 'string') return false;
	return (
		input.startsWith('/') ||
		input.startsWith('\\') ||
		/^[A-Za-z]:/.test(input) ||
		input.split(/[\\/]/).includes('..') ||
		input.includes('\0')
	);
}

function failed(error: NotePersistenceFailure): {
	readonly kind: 'failed';
	readonly error: NotePersistenceFailure;
};
function failed<TTransformError>(
	error: NotePersistenceError<TTransformError>,
): {
	readonly kind: 'failed';
	readonly error: NotePersistenceError<TTransformError>;
};
function failed(error: NotePersistenceError<unknown>) {
	return { kind: 'failed', error };
}
