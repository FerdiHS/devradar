import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { FileManager, Vault } from 'obsidian';
import type { CanonicalEventId } from '../src/domain/activity';
import type { SyncDomainError } from '../src/domain/sync';
import type {
	CurrentContentTransform,
	NotePersistence,
	NotePersistenceFailure,
	NoteProcessResult,
	NoteReadResult,
} from '../src/application/note-persistence';
import { createObsidianNotePersistence } from '../src/adapters/obsidian-notes';
import {
	associatePersonNote,
	parsePersonNote,
	replaceManagedContent,
	renderNewPersonNote,
	type PersonIdentity,
} from '../src/domain/person-note';

const { FakeTFile, FakeTFolder, requireApiVersion } = vi.hoisted(() => ({
	FakeTFile: class FakeTFile {
		constructor(readonly path: string) {}
	},
	FakeTFolder: class FakeTFolder {
		constructor(readonly path: string) {}
	},
	requireApiVersion: vi.fn(() => true),
}));

vi.mock('obsidian', () => ({
	TFile: FakeTFile,
	TFolder: FakeTFolder,
	requireApiVersion,
}));

function vault() {
	const fakeVault = {
		getAbstractFileByPath: vi.fn(),
		read: vi.fn(async () => VALID_NOTE),
		create: vi.fn(),
		createFolder: vi.fn(),
		process: vi.fn(),
	};
	return fakeVault satisfies Pick<
		Vault,
		'getAbstractFileByPath' | 'read' | 'create' | 'createFolder' | 'process'
	>;
}

type FakeVault = ReturnType<typeof vault>;

function adapter(
	fakeVault: FakeVault,
	fileManager: Pick<FileManager, 'processFrontMatter'> = {
		processFrontMatter: vi.fn(async () => undefined),
	},
): NotePersistence {
	return createObsidianNotePersistence(fakeVault, fileManager);
}

const IDENTITY: PersonIdentity = { username: 'octocat', githubId: '583231' };

const VALID_NOTE = [
	'---',
	'devradarGithubId: "583231"',
	'devradarGithubUsername: "octocat"',
	'---',
	'',
	'Before',
	'',
	'<!-- devradar:begin github="octocat" github-id="583231" -->',
	'## DevRadar activity',
	'',
	'_No activity recorded by DevRadar yet._',
	'<!-- devradar:end github="octocat" github-id="583231" -->',
	'',
	'After',
].join('\n');

describe('Obsidian note persistence contract', () => {
	it('preserves caller-owned transform rejection types', () => {
		type CallerError = SyncDomainError;
		const transform: CurrentContentTransform<CallerError> = () => ({
			kind: 'reject',
			error: {
				kind: 'unconfirmed-accounting',
				providerEventId: '123' as CanonicalEventId,
			},
		});

		expectTypeOf(transform).toEqualTypeOf<
			CurrentContentTransform<CallerError>
		>();
		expectTypeOf<NoteProcessResult<CallerError>>().toExtend<{
			kind: 'changed' | 'unchanged' | 'failed';
		}>();

		type ReadError = Extract<NoteReadResult, { kind: 'failed' }>['error'];
		expectTypeOf<ReadError>().toEqualTypeOf<NotePersistenceFailure>();
	});
});

describe('Obsidian note persistence path and target boundaries', () => {
	let fakeVault: FakeVault;
	let notes: NotePersistence;

	beforeEach(() => {
		fakeVault = vault();
		requireApiVersion.mockReturnValue(true);
		notes = adapter(fakeVault);
	});

	it.each([
		['People//octocat.md', 'non-canonical'],
		['../octocat.md', 'unsafe'],
		['/People/octocat.md', 'unsafe'],
		['C:/People/octocat.md', 'unsafe'],
		['People/octocat.txt', 'invalid'],
	] as const)(
		'rejects path %s before any vault operation',
		async (path, reason) => {
			await expect(notes.read(path)).resolves.toMatchObject({
				kind: 'failed',
				error: { kind: 'invalid-path', reason },
			});
			await expect(
				notes.prepareAssociation(path, IDENTITY, () => ({
					kind: 'reuse',
				})),
			).resolves.toMatchObject({
				kind: 'failed',
				error: { kind: 'invalid-path', reason },
			});
			await expect(
				notes.process(path, () => ({ kind: 'replace', markdown: '' })),
			).resolves.toMatchObject({
				kind: 'failed',
				error: { kind: 'invalid-path', reason },
			});
			expect(fakeVault.getAbstractFileByPath).not.toHaveBeenCalled();
			expect(fakeVault.read).not.toHaveBeenCalled();
			expect(fakeVault.create).not.toHaveBeenCalled();
			expect(fakeVault.process).not.toHaveBeenCalled();
		},
	);

	it('rejects a missing read target without creating it', async () => {
		fakeVault.getAbstractFileByPath.mockReturnValue(undefined);

		expect(await notes.read('People/octocat.md')).toEqual({
			kind: 'failed',
			error: { kind: 'missing-target' },
		});
		expect(fakeVault.create).not.toHaveBeenCalled();
	});

	it('reads current Markdown from a file target', async () => {
		const file = new FakeTFile('People/octocat.md');
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.read.mockResolvedValue(VALID_NOTE);

		expect(await notes.read('People/octocat.md')).toEqual({
			kind: 'read',
			markdown: VALID_NOTE,
		});
		expect(fakeVault.read).toHaveBeenCalledWith(file);
	});

	it('creates missing association targets but rejects missing process targets', async () => {
		fakeVault.getAbstractFileByPath.mockReturnValue(undefined);
		fakeVault.create.mockResolvedValue(new FakeTFile('People/octocat.md'));

		expect(
			await notes.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				() => ({ kind: 'reuse' }),
			),
		).toEqual({ kind: 'created' });
		fakeVault.getAbstractFileByPath.mockReturnValue(undefined);
		expect(
			await notes.process('People/octocat.md', () => ({
				kind: 'replace',
				markdown: '',
			})),
		).toEqual({ kind: 'failed', error: { kind: 'missing-target' } });
		expect(fakeVault.process).not.toHaveBeenCalled();
	});

	it('rejects a folder target for read, association, and process', async () => {
		fakeVault.getAbstractFileByPath.mockReturnValue({
			path: 'People',
			children: [],
		});

		expect(await notes.read('People/octocat.md')).toMatchObject({
			kind: 'failed',
			error: { kind: 'non-file-target' },
		});
		expect(
			await notes.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				() => ({ kind: 'reuse' }),
			),
		).toMatchObject({
			kind: 'failed',
			error: { kind: 'non-file-target' },
		});
		expect(
			await notes.process('People/octocat.md', () => ({
				kind: 'replace',
				markdown: '',
			})),
		).toMatchObject({
			kind: 'failed',
			error: { kind: 'non-file-target' },
		});
		expect(fakeVault.read).not.toHaveBeenCalled();
		expect(fakeVault.process).not.toHaveBeenCalled();
	});

	it('translates read failures', async () => {
		const file = new FakeTFile('People/octocat.md');
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.read.mockRejectedValue(new Error('read failed'));

		expect(await notes.read('People/octocat.md')).toEqual({
			kind: 'failed',
			error: { kind: 'read-failure' },
		});
	});

	it('translates target lookup failures without leaking platform exceptions', async () => {
		fakeVault.getAbstractFileByPath.mockImplementation(() => {
			throw new Error('lookup failed');
		});

		expect(await notes.read('People/octocat.md')).toEqual({
			kind: 'failed',
			error: { kind: 'read-failure' },
		});
		expect(
			await notes.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				() => ({ kind: 'reuse' }),
			),
		).toEqual({ kind: 'failed', error: { kind: 'process-failure' } });
		expect(
			await notes.process('People/octocat.md', () => ({
				kind: 'replace',
				markdown: '',
			})),
		).toEqual({ kind: 'failed', error: { kind: 'process-failure' } });
	});

	it('creates the canonical new person note for explicit association', async () => {
		const rendered = renderNewPersonNote(IDENTITY);
		if (!rendered.ok) throw new Error('expected canonical note fixture');
		const canonical = rendered.value;
		fakeVault.getAbstractFileByPath.mockReturnValue(undefined);
		fakeVault.create.mockResolvedValue(new FakeTFile('People/octocat.md'));

		expect(
			await notes.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				() => ({ kind: 'reuse' }),
			),
		).toEqual({ kind: 'created' });
		expect(fakeVault.create).toHaveBeenCalledWith(
			'People/octocat.md',
			canonical,
		);
	});

	it('adds missing Properties before initializing a marker-free note', async () => {
		const file = new FakeTFile('People/octocat.md');
		let current = '---\ntitle: User note\n---\n\nUser content';
		const processFrontMatter = vi.fn(
			async (
				_file: unknown,
				callback: (frontmatter: Record<string, unknown>) => void,
			) => {
				const frontmatter: Record<string, unknown> = {
					title: 'User note',
				};
				callback(frontmatter);
				current = `---\ntitle: ${String(frontmatter.title)}\ndevradarGithubId: "583231"\ndevradarGithubUsername: "octocat"\n---\n\nUser content`;
			},
		);
		const fileManager = {
			processFrontMatter: processFrontMatter as Pick<
				FileManager,
				'processFrontMatter'
			>['processFrontMatter'],
		};
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.read.mockResolvedValue(current);
		fakeVault.process.mockImplementation(
			(_file: unknown, callback: (content: string) => string) => {
				current = callback(current);
			},
		);
		const notesWithProperties = adapter(fakeVault, fileManager);
		const result = await notesWithProperties.prepareAssociation(
			'People/octocat.md',
			IDENTITY,
			(content) => {
				const associated = associatePersonNote(content, IDENTITY, []);
				return associated.ok
					? {
							kind: 'initialize',
							markdown: associated.value.markdown,
						}
					: { kind: 'reject', error: associated.error };
			},
		);

		expect(result).toEqual({ kind: 'initialized' });
		expect(processFrontMatter).toHaveBeenCalledOnce();
		expect(current).toContain('devradarGithubId: "583231"');
		expect(current).toContain(
			'<!-- devradar:begin github="octocat" github-id="583231" -->',
		);
	});

	it('fails before mutation when the frontmatter API is unavailable', async () => {
		const file = new FakeTFile('People/octocat.md');
		const processFrontMatter = vi.fn(async () => undefined);
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.read.mockResolvedValue('User content without frontmatter');
		requireApiVersion.mockReturnValueOnce(false);
		const notesWithProperties = adapter(fakeVault, { processFrontMatter });

		await expect(
			notesWithProperties.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				(content) => {
					const associated = associatePersonNote(
						content,
						IDENTITY,
						[],
					);
					return associated.ok
						? {
								kind: 'initialize',
								markdown: associated.value.markdown,
							}
						: { kind: 'reject', error: associated.error };
				},
			),
		).resolves.toEqual({
			kind: 'failed',
			error: { kind: 'process-failure' },
		});
		expect(processFrontMatter).not.toHaveBeenCalled();
		expect(fakeVault.process).not.toHaveBeenCalled();
	});

	it('rechecks ownership before adding missing Properties', async () => {
		const file = new FakeTFile('People/octocat.md');
		const markerFree = '---\ntitle: User note\n---\n\nUser content';
		const foreign = VALID_NOTE.replaceAll(
			'github="octocat"',
			'github="other-person"',
		);
		const processFrontMatter = vi.fn(async () => undefined);
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.read
			.mockResolvedValueOnce(markerFree)
			.mockResolvedValueOnce(foreign);
		const notesWithProperties = adapter(fakeVault, { processFrontMatter });

		await expect(
			notesWithProperties.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				(content) => {
					const associated = associatePersonNote(
						content,
						IDENTITY,
						[],
					);
					return associated.ok
						? {
								kind: 'initialize',
								markdown: associated.value.markdown,
							}
						: { kind: 'reject', error: associated.error };
				},
			),
		).resolves.toEqual({
			kind: 'failed',
			error: {
				kind: 'transform-rejection',
				error: {
					kind: 'identity-mismatch',
					reason: 'expected',
					actual: { username: 'other-person', githubId: '583231' },
					expected: IDENTITY,
				},
			},
		});
		expect(processFrontMatter).not.toHaveBeenCalled();
		expect(fakeVault.process).not.toHaveBeenCalled();
	});

	it('reports frontmatter API failure without initializing the note', async () => {
		const file = new FakeTFile('People/octocat.md');
		const processFrontMatter = vi.fn(async () => {
			throw new Error('frontmatter failed');
		});
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.read.mockResolvedValue(
			'---\ntitle: User note\n---\n\nUser content',
		);
		const notesWithProperties = adapter(fakeVault, { processFrontMatter });

		await expect(
			notesWithProperties.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				() => ({ kind: 'initialize', markdown: 'initialized' }),
			),
		).resolves.toEqual({
			kind: 'failed',
			error: { kind: 'process-failure' },
		});
		expect(fakeVault.process).not.toHaveBeenCalled();
	});

	it('rejects an invalid identity before creating a missing association target', async () => {
		fakeVault.getAbstractFileByPath.mockReturnValue(undefined);
		const invalidIdentity: PersonIdentity = {
			username: 'not valid',
			githubId: IDENTITY.githubId,
		};

		expect(
			await notes.prepareAssociation(
				'People/octocat.md',
				invalidIdentity,
				() => ({ kind: 'reuse' }),
			),
		).toEqual({
			kind: 'failed',
			error: {
				kind: 'transform-rejection',
				error: { kind: 'invalid-identity', field: 'username' },
			},
		});
		expect(fakeVault.create).not.toHaveBeenCalled();
	});

	it('translates creation conflicts without overwriting the destination', async () => {
		fakeVault.getAbstractFileByPath.mockReturnValue(undefined);
		fakeVault.create.mockRejectedValue(new Error('already exists'));

		expect(
			await notes.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				() => ({ kind: 'reuse' }),
			),
		).toEqual({ kind: 'failed', error: { kind: 'create-failure' } });
	});

	it('creates missing parent folders in root-to-leaf order', async () => {
		fakeVault.getAbstractFileByPath
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce(undefined);
		fakeVault.createFolder.mockResolvedValue(undefined);
		fakeVault.create.mockResolvedValue(
			new FakeTFile('People/Team/octocat.md'),
		);

		await notes.prepareAssociation(
			'People/Team/octocat.md',
			IDENTITY,
			() => ({ kind: 'reuse' }),
		);

		expect(fakeVault.createFolder.mock.calls).toEqual([
			['People'],
			['People/Team'],
		]);
		expect(fakeVault.create).toHaveBeenCalledWith(
			'People/Team/octocat.md',
			expect.any(String),
		);
	});

	it('reuses existing folders and does not create one for a root note', async () => {
		fakeVault.getAbstractFileByPath.mockReturnValue(undefined);
		fakeVault.create.mockResolvedValue(new FakeTFile('octocat.md'));
		expect(
			await notes.prepareAssociation('octocat.md', IDENTITY, () => ({
				kind: 'reuse',
			})),
		).toEqual({ kind: 'created' });
		expect(fakeVault.createFolder).not.toHaveBeenCalled();

		fakeVault.getAbstractFileByPath
			.mockReset()
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce(new FakeTFolder('People'));
		fakeVault.create.mockResolvedValue(new FakeTFile('People/octocat.md'));
		expect(
			await notes.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				() => ({
					kind: 'reuse',
				}),
			),
		).toEqual({ kind: 'created' });
		expect(fakeVault.createFolder).not.toHaveBeenCalled();
		expect(fakeVault.create).toHaveBeenCalledWith(
			'People/octocat.md',
			expect.any(String),
		);
	});

	it('fails without creating the note when a parent is not a folder', async () => {
		fakeVault.getAbstractFileByPath
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce({ path: 'People' });
		await expect(
			notes.prepareAssociation('People/octocat.md', IDENTITY, () => ({
				kind: 'reuse',
			})),
		).resolves.toEqual({
			kind: 'failed',
			error: { kind: 'create-failure' },
		});
		expect(fakeVault.create).not.toHaveBeenCalled();
	});

	it('keeps earlier folders when a later folder creation fails', async () => {
		fakeVault.getAbstractFileByPath
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce(undefined);
		fakeVault.createFolder
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('folder failed'));
		await expect(
			notes.prepareAssociation(
				'People/Team/octocat.md',
				IDENTITY,
				() => ({ kind: 'reuse' }),
			),
		).resolves.toEqual({
			kind: 'failed',
			error: { kind: 'create-failure' },
		});
		expect(fakeVault.createFolder).toHaveBeenCalledWith('People');
		expect(fakeVault.create).not.toHaveBeenCalled();
	});

	it('fails safely when a parent lookup throws', async () => {
		fakeVault.getAbstractFileByPath
			.mockReturnValueOnce(undefined)
			.mockImplementationOnce(() => {
				throw new Error('lookup failed');
			});
		await expect(
			notes.prepareAssociation(
				'People/Team/octocat.md',
				IDENTITY,
				() => ({ kind: 'reuse' }),
			),
		).resolves.toEqual({
			kind: 'failed',
			error: { kind: 'create-failure' },
		});
		expect(fakeVault.create).not.toHaveBeenCalled();
	});
});

describe('Obsidian note persistence current-content processing', () => {
	let fakeVault: FakeVault;
	let notes: NotePersistence;

	beforeEach(() => {
		fakeVault = vault();
		requireApiVersion.mockReturnValue(true);
		notes = adapter(fakeVault);
	});

	it('processes callback-supplied current content and preserves outside bytes', async () => {
		const file = new FakeTFile('People/octocat.md');
		const current = VALID_NOTE.replace('Before', 'Edited before').replace(
			'_No activity recorded by DevRadar yet._',
			'- `2026-08-26T00:00:00Z` — old activity',
		);
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		let persisted: string | undefined;
		fakeVault.read.mockImplementation(async () => persisted ?? current);
		fakeVault.process.mockImplementation(
			(_file: unknown, transform: (content: string) => string) => {
				persisted = transform(current);
			},
		);

		const expected = current.replace(
			'- `2026-08-26T00:00:00Z` — old activity',
			'_No activity recorded by DevRadar yet._',
		);
		const result = await notes.process('People/octocat.md', (content) => {
			const transformed = replaceManagedContent(content, IDENTITY, []);
			return transformed.ok
				? { kind: 'replace', markdown: transformed.value.markdown }
				: { kind: 'reject', error: transformed.error };
		});

		expect(result).toEqual({ kind: 'changed' });
		expect(persisted).toBe(expected);
		expect(await notes.read('People/octocat.md')).toEqual({
			kind: 'read',
			markdown: expected,
		});
	});

	it('keeps ordinary processing independent from association Properties', async () => {
		const file = new FakeTFile('People/octocat.md');
		const processFrontMatter = vi.fn(async () => undefined);
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.process.mockImplementation(
			(_file: unknown, callback: (content: string) => string) => {
				callback(VALID_NOTE.replace('583231', 'not-a-valid-id'));
			},
		);
		const ordinaryNotes = adapter(fakeVault, { processFrontMatter });

		await ordinaryNotes.process('People/octocat.md', (content) => ({
			kind: 'replace',
			markdown: content,
		}));

		expect(processFrontMatter).not.toHaveBeenCalled();
	});

	it('reports unchanged when the current transform returns identical content', async () => {
		const file = new FakeTFile('People/octocat.md');
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.process.mockImplementation(
			(_file: unknown, transform: (content: string) => string) => {
				expect(transform(VALID_NOTE)).toBe(VALID_NOTE);
			},
		);

		expect(
			await notes.process('People/octocat.md', (content) => ({
				kind: 'replace',
				markdown: content,
			})),
		).toEqual({ kind: 'unchanged' });
	});

	it('fails closed when current-content processing is unavailable', async () => {
		const file = new FakeTFile('People/octocat.md');
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		requireApiVersion.mockReturnValue(false);

		expect(
			await notes.process('People/octocat.md', () => ({
				kind: 'replace',
				markdown: '',
			})),
		).toEqual({ kind: 'failed', error: { kind: 'process-failure' } });
		expect(
			await notes.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				() => ({ kind: 'reuse' }),
			),
		).toEqual({
			kind: 'failed',
			error: { kind: 'process-failure' },
		});
		expect(fakeVault.process).not.toHaveBeenCalled();
	});

	it('preserves caller-owned domain rejection data', async () => {
		const file = new FakeTFile('People/octocat.md');
		const error: SyncDomainError = {
			kind: 'unconfirmed-accounting',
			providerEventId: '123' as CanonicalEventId,
		};
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.process.mockImplementation(
			(_file: unknown, transform: (content: string) => string) => {
				expect(transform(VALID_NOTE)).toBe(VALID_NOTE);
			},
		);

		expect(
			await notes.process<SyncDomainError>('People/octocat.md', () => ({
				kind: 'reject',
				error,
			})),
		).toEqual({
			kind: 'failed',
			error: { kind: 'transform-rejection', error },
		});
	});

	it('reports process failure over a recorded transform rejection', async () => {
		const file = new FakeTFile('People/octocat.md');
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.process.mockImplementation(
			(_file: unknown, transform: (content: string) => string) => {
				transform(VALID_NOTE);
				throw new Error('process failed');
			},
		);

		expect(
			await notes.process<SyncDomainError>('People/octocat.md', () => ({
				kind: 'reject',
				error: {
					kind: 'unconfirmed-accounting',
					providerEventId: '123' as CanonicalEventId,
				},
			})),
		).toEqual({
			kind: 'failed',
			error: { kind: 'process-failure' },
		});
	});

	it('reports thrown transforms as transform failure', async () => {
		const file = new FakeTFile('People/octocat.md');
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.process.mockImplementation(
			(_file: unknown, transform: (content: string) => string) => {
				expect(transform(VALID_NOTE)).toBe(VALID_NOTE);
			},
		);

		expect(
			await notes.process('People/octocat.md', () => {
				throw new Error('unexpected transform failure');
			}),
		).toEqual({ kind: 'failed', error: { kind: 'transform-failure' } });
	});

	it('preserves current Markdown when the domain rejects malformed markers', async () => {
		const file = new FakeTFile('People/octocat.md');
		const current = VALID_NOTE.replace(
			'github-id="583231" -->',
			'github-id="583231" extra -->',
		);
		let persisted: string | undefined;
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.process.mockImplementation(
			(_file: unknown, transform: (content: string) => string) => {
				persisted = transform(current);
			},
		);

		const result = await notes.process('People/octocat.md', (content) => {
			const transformed = replaceManagedContent(content, IDENTITY, []);
			return transformed.ok
				? { kind: 'replace', markdown: transformed.value.markdown }
				: { kind: 'reject', error: transformed.error };
		});

		expect(result).toEqual({
			kind: 'failed',
			error: {
				kind: 'transform-rejection',
				error: { kind: 'malformed-marker', marker: 'begin' },
			},
		});
		expect(persisted).toBe(current);
	});

	it('preserves current Markdown for foreign markers', async () => {
		const file = new FakeTFile('People/octocat.md');
		const current = VALID_NOTE.replaceAll('octocat', 'other-person');
		let persisted: string | undefined;
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.process.mockImplementation(
			(_file: unknown, transform: (content: string) => string) => {
				persisted = transform(current);
			},
		);

		const result = await notes.process('People/octocat.md', (content) => {
			const transformed = replaceManagedContent(content, IDENTITY, []);
			return transformed.ok
				? { kind: 'replace', markdown: transformed.value.markdown }
				: { kind: 'reject', error: transformed.error };
		});

		expect(result).toEqual({
			kind: 'failed',
			error: {
				kind: 'transform-rejection',
				error: {
					kind: 'identity-mismatch',
					reason: 'expected',
					actual: { username: 'other-person', githubId: '583231' },
					expected: IDENTITY,
				},
			},
		});
		expect(persisted).toBe(current);
	});

	it('preserves current Markdown for ambiguous markers', async () => {
		const file = new FakeTFile('People/octocat.md');
		const endMarker =
			'<!-- devradar:end github="octocat" github-id="583231" -->';
		const current = VALID_NOTE.replace(
			endMarker,
			`${endMarker}\n${endMarker}`,
		);
		let persisted: string | undefined;
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.process.mockImplementation(
			(_file: unknown, transform: (content: string) => string) => {
				persisted = transform(current);
			},
		);

		const result = await notes.process('People/octocat.md', (content) => {
			const transformed = replaceManagedContent(content, IDENTITY, []);
			return transformed.ok
				? { kind: 'replace', markdown: transformed.value.markdown }
				: { kind: 'reject', error: transformed.error };
		});

		expect(result).toEqual({
			kind: 'failed',
			error: {
				kind: 'transform-rejection',
				error: { kind: 'ambiguous-marker', reason: 'duplicate-end' },
			},
		});
		expect(persisted).toBe(current);
	});

	it('preserves association rejection during preflight', async () => {
		const file = new FakeTFile('People/octocat.md');
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		const rejection = {
			kind: 'missing-marker' as const,
			missing: 'associated-section' as const,
		};
		fakeVault.process.mockImplementation(
			(_file: unknown, transform: (content: string) => string) => {
				expect(transform(VALID_NOTE)).toBe(VALID_NOTE);
			},
		);

		expect(
			await notes.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				() => ({
					kind: 'reject',
					error: rejection,
				}),
			),
		).toEqual({
			kind: 'failed',
			error: { kind: 'transform-rejection', error: rejection },
		});
	});

	it('initializes marker-free current content through the association transform', async () => {
		const file = new FakeTFile('People/octocat.md');
		const current =
			'---\ndevradarGithubId: "583231"\ndevradarGithubUsername: "octocat"\n---\n\nCurrent user content';
		const associated = associatePersonNote(current, IDENTITY, []);
		if (!associated.ok) throw new Error('expected association fixture');
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.process.mockImplementation(
			(_file: unknown, transform: (content: string) => string) => {
				const output = transform(current);
				expect(output).toBe(associated.value.markdown);
			},
		);

		expect(
			await notes.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				(content) => {
					const parsed = parsePersonNote(content, IDENTITY);
					if (parsed.kind === 'valid-section')
						return { kind: 'reuse' };
					if (parsed.kind === 'marker-free') {
						const result = associatePersonNote(
							content,
							IDENTITY,
							[],
						);
						return result.ok
							? {
									kind: 'initialize',
									markdown: result.value.markdown,
								}
							: { kind: 'reject', error: result.error };
					}
					return parsed.kind === 'invalid'
						? { kind: 'reject', error: parsed.error }
						: { kind: 'reuse' };
				},
			),
		).toEqual({ kind: 'initialized' });
	});

	it('reuses a valid current section without erasing its activity', async () => {
		const file = new FakeTFile('People/octocat.md');
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.process.mockImplementation(
			(_file: unknown, transform: (content: string) => string) => {
				expect(transform(VALID_NOTE)).toBe(VALID_NOTE);
			},
		);

		expect(
			await notes.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				(content) => {
					const parsed = parsePersonNote(content, IDENTITY);
					return parsed.kind === 'valid-section'
						? { kind: 'reuse' }
						: parsed.kind === 'invalid'
							? { kind: 'reject', error: parsed.error }
							: {
									kind: 'reject',
									error: {
										kind: 'missing-marker',
										missing: 'associated-section',
									},
								};
				},
			),
		).toEqual({ kind: 'reused' });
	});

	it('reports association transform throws as transform failure', async () => {
		const file = new FakeTFile('People/octocat.md');
		fakeVault.getAbstractFileByPath.mockReturnValue(file);
		fakeVault.process.mockImplementation(
			(_file: unknown, transform: (content: string) => string) => {
				expect(transform(VALID_NOTE)).toBe(VALID_NOTE);
			},
		);

		expect(
			await notes.prepareAssociation(
				'People/octocat.md',
				IDENTITY,
				() => {
					throw new Error('unexpected association failure');
				},
			),
		).toEqual({ kind: 'failed', error: { kind: 'transform-failure' } });
	});
});
