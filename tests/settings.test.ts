import { describe, expect, it } from 'vitest';
import {
	canonicalizeDraftNotePath,
	createEmptyPersonSyncState,
	createEmptySettingsV1,
	validatePersistedSettingsV1,
} from '../src/domain/settings';

const NOW = '2026-08-20T12:00:00.000Z';
const PROVIDER_TIME = '2026-08-19T12:00:00Z';

function validPerson(overrides: Record<string, unknown> = {}) {
	return {
		username: 'octocat',
		githubAccountId: '583231',
		notePath: 'People/octocat.md',
		trackingStart: { mode: 'from-date', at: '2026-08-01T00:00:00.000Z' },
		syncState: {
			seenEvents: [{ id: '123', createdAt: PROVIDER_TIME }],
			github: {},
		},
		...overrides,
	};
}

function validSettings(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		followedPeople: [validPerson()],
		...overrides,
	};
}

function expectFailure(
	input: unknown,
	code: string,
	path: string,
	currentInstant = NOW,
) {
	const result = validatePersistedSettingsV1(input, currentInstant);
	expect(result).toMatchObject({
		ok: false,
		error: { code, path },
	});
	if (result.ok) throw new Error('expected validation failure');
	expect(result.error.message).toBeTruthy();
	expect(Object.keys(result.error).sort()).toEqual([
		'code',
		'message',
		'path',
	]);
	return result.error;
}

describe('schema-v1 settings construction', () => {
	it('constructs fresh canonical empty values', () => {
		const settings = createEmptySettingsV1();
		const secondSettings = createEmptySettingsV1();
		const state = createEmptyPersonSyncState();
		const secondState = createEmptyPersonSyncState();

		expect(settings).toEqual({ schemaVersion: 1, followedPeople: [] });
		expect(state).toEqual({ seenEvents: [], github: {} });
		expect(settings).not.toBe(secondSettings);
		expect(settings.followedPeople).not.toBe(secondSettings.followedPeople);
		expect(state).not.toBe(secondState);
		expect(state.seenEvents).not.toBe(secondState.seenEvents);
		expect(state.github).not.toBe(secondState.github);
	});

	it('maps only the explicit absence values to empty settings', () => {
		expect(validatePersistedSettingsV1(undefined, NOW)).toEqual({
			ok: true,
			value: createEmptySettingsV1(),
		});
		expect(validatePersistedSettingsV1({}, NOW)).toEqual({
			ok: true,
			value: createEmptySettingsV1(),
		});
		expectFailure(null, 'invalid-type', '');
		expectFailure({ legacy: true }, 'unexpected-field', '/legacy');
	});
});

describe('schema-v1 persisted validation', () => {
	it('reconstructs fresh data without mutation or aliases', () => {
		const input = validSettings();
		const original = JSON.parse(JSON.stringify(input)) as typeof input;
		const result = validatePersistedSettingsV1(input, NOW);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('expected successful validation');
		expect(result.value).toEqual(input);
		expect(input).toEqual(original);
		expect(result.value).not.toBe(input);
		expect(result.value.followedPeople).not.toBe(input.followedPeople);
		expect(result.value.followedPeople[0]?.syncState).not.toBe(
			(input.followedPeople[0] as { syncState: unknown }).syncState,
		);
		result.value.followedPeople[0]?.syncState.seenEvents.push({
			id: '456',
			createdAt: PROVIDER_TIME,
		});
		expect(input.followedPeople[0]?.syncState.seenEvents).toHaveLength(1);
	});

	it('strips accepted null prototypes during reconstruction', () => {
		const input = Object.assign(
			Object.create(null) as Record<string, unknown>,
			validSettings({
				followedPeople: [
					Object.assign(
						Object.create(null) as Record<string, unknown>,
						validPerson(),
					),
				],
			}),
		);
		const result = validatePersistedSettingsV1(input, NOW);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('expected successful validation');
		expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(result.value.followedPeople[0])).toBe(
			Object.prototype,
		);
	});

	it('preserves followed-person and seen-event order', () => {
		const input = validSettings({
			followedPeople: [
				validPerson({
					username: 'first',
					githubAccountId: '1',
					notePath: 'People/first.md',
					syncState: {
						seenEvents: [
							{ id: '10', createdAt: PROVIDER_TIME },
							{ id: '11', createdAt: PROVIDER_TIME },
						],
						github: {},
					},
				}),
				validPerson({
					username: 'second',
					githubAccountId: '2',
					notePath: 'People/second.md',
				}),
			],
		});
		const result = validatePersistedSettingsV1(input, NOW);
		if (!result.ok) throw new Error('expected successful validation');
		expect(
			result.value.followedPeople.map((person) => person.username),
		).toEqual(['first', 'second']);
		expect(
			result.value.followedPeople[0]?.syncState.seenEvents.map(
				(event) => event.id,
			),
		).toEqual(['10', '11']);
	});

	it('uses strict schema and deterministic first-failure ordering', () => {
		expectFailure(
			{ schemaVersion: 1, followedPeople: [], z: true, a: true },
			'unexpected-field',
			'/a',
		);
		expectFailure({ something: true }, 'unexpected-field', '/something');
		expectFailure({ schemaVersion: 1 }, 'missing-field', '/followedPeople');
		expectFailure(
			{ schemaVersion: '1', followedPeople: [] },
			'invalid-schema-version',
			'/schemaVersion',
		);
		expectFailure(
			{ schemaVersion: 2, followedPeople: [] },
			'unsupported-schema-version',
			'/schemaVersion',
		);
		expectFailure(
			validSettings({ followedPeople: [validPerson({ extra: true })] }),
			'unexpected-field',
			'/followedPeople/0/extra',
		);
		expectFailure(
			{ schemaVersion: 1, followedPeople: [], 'a/b': true },
			'unexpected-field',
			'/a~1b',
		);
		expectFailure(
			{ schemaVersion: 1, followedPeople: [], 'a~b': true },
			'unexpected-field',
			'/a~0b',
		);
		expectFailure(
			{ schemaVersion: 1, followedPeople: [], ['\u0000']: true },
			'unexpected-field',
			'/\u0000',
		);
		const withUnexpectedFieldAndThrowingGetter = validSettings({
			followedPeople: [],
		}) as Record<string, unknown>;
		Object.defineProperty(withUnexpectedFieldAndThrowingGetter, 'schemaVersion', {
			enumerable: true,
			get: () => {
				throw new Error('schemaVersion should not be read');
			},
		});
		withUnexpectedFieldAndThrowingGetter.z = true;
		expectFailure(
			withUnexpectedFieldAndThrowingGetter,
			'unexpected-field',
			'/z',
		);
	});

	it('rejects unsafe values and present undefined fields', () => {
		expectFailure(1n, 'invalid-type', '');
		expectFailure(
			validSettings({ followedPeople: undefined }),
			'invalid-type',
			'/followedPeople',
		);
		const symbolKey = Symbol('extra');
		const withSymbol = validSettings() as Record<PropertyKey, unknown>;
		withSymbol[symbolKey] = true;
		expectFailure(withSymbol, 'invalid-type', '');
		const withGetter = validSettings() as Record<string, unknown>;
		Object.defineProperty(withGetter, 'schemaVersion', {
			enumerable: true,
			get: () => true,
		});
		expectFailure(withGetter, 'invalid-type', '/schemaVersion');
	});

	it('returns structured errors for revoked proxies', () => {
		const root = Proxy.revocable({}, {});
		root.revoke();
		expectFailure(root.proxy, 'invalid-type', '');

		const followedPeople = Proxy.revocable([], {});
		followedPeople.revoke();
		expectFailure(
			{ schemaVersion: 1, followedPeople: followedPeople.proxy },
			'invalid-type',
			'/followedPeople',
		);
	});

	it('does not read through live proxy traps after inspection', () => {
		const input = new Proxy(
			{ schemaVersion: 1, followedPeople: [] },
			{
				get(target, property) {
					if (property === 'schemaVersion') throw new Error('trap');
					return target[property as keyof typeof target];
				},
			},
		);
		expect(validatePersistedSettingsV1(input, NOW)).toEqual({
			ok: true,
			value: createEmptySettingsV1(),
		});

		const followedPeople = new Proxy([], {
			get() {
				throw new Error('trap');
			},
		});
		expectFailure(
			{ schemaVersion: 1, followedPeople },
			'invalid-type',
			'/followedPeople',
		);
	});

	it('does not treat non-enumerable own fields as legacy absence', () => {
		const input = {};
		Object.defineProperty(input, 'schemaVersion', { value: 1 });

		expectFailure(input, 'missing-field', '/schemaVersion');
	});
});

describe('schema-v1 field validation', () => {
	it('validates identity and persisted paths without coercion', () => {
		expectFailure(
			validSettings({
				followedPeople: [validPerson({ username: 'octo--cat' })],
			}),
			'invalid-username',
			'/followedPeople/0/username',
		);
		expectFailure(
			validSettings({
				followedPeople: [validPerson({ githubAccountId: 583231 })],
			}),
			'invalid-github-account-id',
			'/followedPeople/0/githubAccountId',
		);
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({ notePath: 'People\\octocat.md' }),
				],
			}),
			'noncanonical-note-path',
			'/followedPeople/0/notePath',
		);
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({ notePath: 'People/octocat.txt' }),
				],
			}),
			'invalid-note-path',
			'/followedPeople/0/notePath',
		);
	});

	it('validates plugin and provider timestamp canonicality', () => {
		const fullState = validatePersistedSettingsV1(
			validSettings({
				githubRequestPolicy: {
					rateLimitNotBefore: '2026-08-20T12:00:00.100Z',
				},
				followedPeople: [
					validPerson({
						trackingStart: {
							mode: 'from-now',
							at: '2026-08-20T12:00:00.100Z',
						},
						syncState: {
							lastAttemptAt: '2026-08-20T12:00:00.100Z',
							lastSuccessfulSyncAt: '2026-08-20T12:00:00.200Z',
							seenEvents: [
								{
									id: '1',
									createdAt: '2026-08-19T12:00:00.1234Z',
								},
							],
							github: {
								pollNotBefore: '2026-08-20T12:00:00.300Z',
							},
						},
					}),
				],
			}),
			NOW,
		);
		expect(fullState.ok).toBe(true);
		expectFailure(
			validSettings(),
			'invalid-plugin-timestamp',
			'',
			'not-a-timestamp',
		);
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({
						syncState: {
							seenEvents: [
								{ id: '01', createdAt: PROVIDER_TIME },
							],
							github: {},
						},
					}),
				],
			}),
			'invalid-provider-event-id',
			'/followedPeople/0/syncState/seenEvents/0/id',
		);
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({
						trackingStart: {
							mode: 'from-date',
							at: '2026-08-01T00:00:00Z',
						},
					}),
				],
			}),
			'noncanonical-plugin-timestamp',
			'/followedPeople/0/trackingStart/at',
		);
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({
						syncState: {
							seenEvents: [
								{
									id: '1',
									createdAt: '2026-08-19T12:00:00.000Z',
								},
							],
							github: {},
						},
					}),
				],
			}),
			'noncanonical-provider-timestamp',
			'/followedPeople/0/syncState/seenEvents/0/createdAt',
		);
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({
						syncState: {
							seenEvents: [
								{ id: '1', createdAt: 'not-a-timestamp' },
							],
							github: {},
						},
					}),
				],
			}),
			'invalid-provider-timestamp',
			'/followedPeople/0/syncState/seenEvents/0/createdAt',
		);
	});

	it('validates global policy boundaries and strict shape', () => {
		for (const rateLimitNotBefore of [
			'2026-08-19T12:00:00.000Z',
			'2026-08-21T12:00:00.000Z',
		]) {
			expect(
				validatePersistedSettingsV1(
					validSettings({
						githubRequestPolicy: { rateLimitNotBefore },
					}),
					NOW,
				),
			).toMatchObject({ ok: true });
		}
		expect(
			validatePersistedSettingsV1(
				validSettings({ githubRequestPolicy: {} }),
				NOW,
			),
		).toMatchObject({ ok: true });
		expectFailure(
			validSettings({
				githubRequestPolicy: { rateLimitNotBefore: 'not-a-timestamp' },
			}),
			'invalid-plugin-timestamp',
			'/githubRequestPolicy/rateLimitNotBefore',
		);
		expectFailure(
			validSettings({ githubRequestPolicy: { extra: true } }),
			'unexpected-field',
			'/githubRequestPolicy/extra',
		);
	});

	it('validates tracking-start variants and the injected current instant', () => {
		for (const trackingStart of [
			{ mode: 'available-recent' },
			{ mode: 'from-now', at: NOW },
			{ mode: 'from-date', at: NOW },
		]) {
			const result = validatePersistedSettingsV1(
				validSettings({
					followedPeople: [validPerson({ trackingStart })],
				}),
				NOW,
			);
			expect(result.ok).toBe(true);
		}
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({
						trackingStart: {
							mode: 'from-date',
							at: '2026-08-21T00:00:00.000Z',
						},
					}),
				],
			}),
			'future-from-date',
			'/followedPeople/0/trackingStart/at',
		);
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({ trackingStart: { mode: 'later' } }),
				],
			}),
			'invalid-tracking-start',
			'/followedPeople/0/trackingStart/mode',
		);
	});
});

describe('schema-v1 uniqueness and nested state validation', () => {
	it('checks duplicate seen IDs after all local event validation', () => {
		const person = validPerson({
			syncState: {
				seenEvents: [
					{ id: '1', createdAt: PROVIDER_TIME },
					{ id: '1', createdAt: PROVIDER_TIME },
				],
				github: {},
			},
		});
		expectFailure(
			validSettings({ followedPeople: [person] }),
			'duplicate-seen-event-id',
			'/followedPeople/0/syncState/seenEvents/1/id',
		);
	});

	it('rejects non-canonical enumerable array keys', () => {
		const seenEvents = Object.assign(
			[
				{ id: '1', createdAt: PROVIDER_TIME },
				{ id: '2', createdAt: PROVIDER_TIME },
			],
			{ '01': true },
		);
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({
						syncState: { seenEvents, github: {} },
					}),
				],
			}),
			'unexpected-field',
			'/followedPeople/0/syncState/seenEvents/01',
		);
	});

	it('reports missing nested fields in schema order', () => {
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({ syncState: { seenEvents: [] } }),
				],
			}),
			'missing-field',
			'/followedPeople/0/syncState/github',
		);
	});

	it('rejects unexpected fields at every persisted object level', () => {
		const cases: Array<[unknown, string]> = [
			[
				validSettings({
					followedPeople: [
						validPerson({
							trackingStart: {
								mode: 'from-now',
								at: NOW,
								extra: true,
							},
						}),
					],
				}),
				'/followedPeople/0/trackingStart/extra',
			],
			[
				validSettings({
					followedPeople: [
						validPerson({
							syncState: {
								lastAttemptAt: NOW,
								seenEvents: [
									{ id: '1', createdAt: PROVIDER_TIME },
								],
								github: {},
								extra: true,
							},
						}),
					],
				}),
				'/followedPeople/0/syncState/extra',
			],
			[
				validSettings({
					followedPeople: [
						validPerson({
							syncState: {
								seenEvents: [
									{
										id: '1',
										createdAt: PROVIDER_TIME,
										extra: true,
									},
								],
								github: {},
							},
						}),
					],
				}),
				'/followedPeople/0/syncState/seenEvents/0/extra',
			],
			[
				validSettings({
					followedPeople: [
						validPerson({
							syncState: {
								seenEvents: [
									{ id: '1', createdAt: PROVIDER_TIME },
								],
								github: { extra: true },
							},
						}),
					],
				}),
				'/followedPeople/0/syncState/github/extra',
			],
		];

		for (const [input, path] of cases)
			expectFailure(input, 'unexpected-field', path);
	});

	it('reports nested unexpected fields before known-field validation', () => {
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({
						trackingStart: { mode: 'later', ['\u0000']: true },
					}),
				],
			}),
			'unexpected-field',
			'/followedPeople/0/trackingStart/\u0000',
		);
	});

	it('checks dataset uniqueness in the documented order', () => {
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({ notePath: 'People/one.md' }),
					validPerson({
						username: 'OCTOCAT',
						githubAccountId: '2',
						notePath: 'People/two.md',
					}),
				],
			}),
			'duplicate-username',
			'/followedPeople/1/username',
		);
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({ notePath: 'People/one.md' }),
					validPerson({
						username: 'two',
						githubAccountId: '583231',
						notePath: 'People/two.md',
					}),
				],
			}),
			'duplicate-github-account-id',
			'/followedPeople/1/githubAccountId',
		);
		expectFailure(
			validSettings({
				followedPeople: [
					validPerson({ username: 'one', notePath: 'People/one.md' }),
					validPerson({
						username: 'two',
						githubAccountId: '2',
						notePath: 'people/ONE.md',
					}),
				],
			}),
			'duplicate-note-path',
			'/followedPeople/1/notePath',
		);
	});
});

describe('draft note-path canonicalization', () => {
	it('normalizes only permitted harmless syntax', () => {
		expect(canonicalizeDraftNotePath('People\\\\./octocat.md')).toEqual({
			ok: true,
			value: 'People/octocat.md',
		});
		expect(canonicalizeDraftNotePath('People//octocat.md')).toEqual({
			ok: true,
			value: 'People/octocat.md',
		});
	});

	it('rejects prohibited raw path forms before normalization', () => {
		for (const path of [
			'',
			'/People/octocat.md',
			'\\\\server\\share\\octocat.md',
			'C:foo.md',
			'C:/foo.md',
			'C:\\foo.md',
			'People/../octocat.md',
			'People/octocat.md/',
			'People/octocat.MD',
			`People/octocat${String.fromCharCode(0)}.md`,
		]) {
			const result = canonicalizeDraftNotePath(path);
			expect(result).toMatchObject({
				ok: false,
				error: { code: 'invalid-note-path' },
			});
		}
	});
});
