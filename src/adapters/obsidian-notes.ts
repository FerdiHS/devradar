import { requireApiVersion, TFile, type Vault } from 'obsidian';
import { canonicalizeDraftNotePath } from '../domain/settings';
import type { PersonNoteFailure } from '../domain/person-note';
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
	vault: Pick<Vault, 'getAbstractFileByPath' | 'read' | 'create' | 'process'>,
): NotePersistence {
	return {
		read: (path) => read(vault, path),
		prepareAssociation: (path, createMarkdown, transform) =>
			prepareAssociation(vault, path, createMarkdown, transform),
		process: (path, transform) => process(vault, path, transform),
	};
}

async function read(
	vault: Pick<Vault, 'getAbstractFileByPath' | 'read'>,
	path: string,
): Promise<NoteReadResult> {
	const validated = validatePath(path);
	if (!validated.ok) return failed<never>(validated.error);
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
	vault: Pick<Vault, 'getAbstractFileByPath' | 'create' | 'process'>,
	path: string,
	createMarkdown: string,
	transform: AssociationTransform,
): Promise<NotePreparationResult> {
	const validated = validatePath(path);
	if (!validated.ok) return failed<PersonNoteFailure>(validated.error);
	const target = resolveTarget(vault, validated.path);
	if (target.kind === 'missing') {
		try {
			await vault.create(validated.path, createMarkdown);
			return { kind: 'created' };
		} catch {
			return failed({ kind: 'create-failure' });
		}
	}
	if (target.kind === 'non-file') return failed({ kind: 'non-file-target' });
	if (target.kind === 'lookup-failure')
		return failed({ kind: 'process-failure' });

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

function failed<TTransformError>(
	error: NotePersistenceError<TTransformError>,
): {
	readonly kind: 'failed';
	readonly error: NotePersistenceError<TTransformError>;
} {
	return { kind: 'failed', error };
}
