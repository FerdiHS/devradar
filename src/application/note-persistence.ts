import type { PersonIdentity, PersonNoteFailure } from '../domain/person-note';

export type NotePersistenceFailure =
	| {
			readonly kind: 'invalid-path';
			readonly reason: 'invalid' | 'non-canonical' | 'unsafe';
	  }
	| { readonly kind: 'missing-target' }
	| { readonly kind: 'non-file-target' }
	| { readonly kind: 'read-failure' }
	| { readonly kind: 'create-failure' }
	| { readonly kind: 'process-failure' };

export type NotePersistenceError<TTransformError = unknown> =
	| NotePersistenceFailure
	| {
			readonly kind: 'transform-rejection';
			readonly error: TTransformError;
	  }
	| { readonly kind: 'transform-failure' };

export type CurrentContentTransform<TTransformError = unknown> = (
	currentMarkdown: string,
) =>
	| { readonly kind: 'replace'; readonly markdown: string }
	| { readonly kind: 'reject'; readonly error: TTransformError };

export type AssociationTransform = (
	currentMarkdown: string,
) =>
	| { readonly kind: 'reuse' }
	| { readonly kind: 'initialize'; readonly markdown: string }
	| { readonly kind: 'reject'; readonly error: PersonNoteFailure };

export type NoteReadResult =
	| { readonly kind: 'read'; readonly markdown: string }
	| {
			readonly kind: 'failed';
			readonly error: NotePersistenceFailure;
	  };

export type NotePreparationResult =
	| { readonly kind: 'created' }
	| { readonly kind: 'initialized' }
	| { readonly kind: 'reused' }
	| {
			readonly kind: 'failed';
			readonly error: NotePersistenceError<PersonNoteFailure>;
	  };

export type NoteProcessResult<TTransformError = unknown> =
	| { readonly kind: 'changed' }
	| { readonly kind: 'unchanged' }
	| {
			readonly kind: 'failed';
			readonly error: NotePersistenceError<TTransformError>;
	  };

export interface NotePersistence {
	read(path: string): Promise<NoteReadResult>;

	prepareAssociation(
		path: string,
		identity: PersonIdentity,
		transform: AssociationTransform,
	): Promise<NotePreparationResult>;

	process<TTransformError>(
		path: string,
		transform: CurrentContentTransform<TTransformError>,
	): Promise<NoteProcessResult<TTransformError>>;
}
