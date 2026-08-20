import {
	canonicalizeEventId,
	canonicalizeTimestamp,
	type TrackingStart,
} from './activity';
import {
	isCanonicalGitHubUsername,
	isCanonicalPositiveDecimalString,
} from './primitives';

export type DevRadarSettingsV1 = {
	readonly schemaVersion: 1;
	readonly followedPeople: FollowedPersonV1[];
	readonly githubRequestPolicy?: GitHubRequestPolicyV1;
};

export type FollowedPersonV1 = {
	readonly username: string;
	readonly githubAccountId: string;
	readonly notePath: string;
	readonly trackingStart: TrackingStart;
	readonly syncState: PersonSyncState;
};

export type GitHubRequestPolicyV1 = {
	readonly rateLimitNotBefore?: string;
};

export type PersonSyncState = {
	readonly lastAttemptAt?: string;
	readonly lastSuccessfulSyncAt?: string;
	readonly seenEvents: SeenEventV1[];
	readonly github: GitHubSyncStateV1;
};

export type SeenEventV1 = {
	readonly id: string;
	readonly createdAt: string;
};

export type GitHubSyncStateV1 = {
	readonly pollNotBefore?: string;
};

export type SchemaV1ValidationCode =
	| 'invalid-type'
	| 'unexpected-field'
	| 'missing-field'
	| 'invalid-schema-version'
	| 'unsupported-schema-version'
	| 'invalid-username'
	| 'invalid-github-account-id'
	| 'invalid-note-path'
	| 'noncanonical-note-path'
	| 'invalid-plugin-timestamp'
	| 'noncanonical-plugin-timestamp'
	| 'invalid-provider-timestamp'
	| 'noncanonical-provider-timestamp'
	| 'invalid-tracking-start'
	| 'future-from-date'
	| 'invalid-provider-event-id'
	| 'duplicate-username'
	| 'duplicate-github-account-id'
	| 'duplicate-note-path'
	| 'duplicate-seen-event-id';

export type SchemaV1ValidationError = {
	readonly code: SchemaV1ValidationCode;
	readonly path: string;
	readonly message: string;
};

export type SchemaV1ValidationResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: SchemaV1ValidationError };

type RecordView = {
	readonly input: object;
	readonly keys: readonly string[];
	readonly hasOwnKeys: boolean;
};

function isValidationError(
	value: readonly unknown[] | SchemaV1ValidationError,
): value is SchemaV1ValidationError {
	return !Array.isArray(value);
}

const PLUGIN_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const success = <T>(value: T): SchemaV1ValidationResult<T> => ({
	ok: true,
	value,
});

const failure = <T>(
	code: SchemaV1ValidationCode,
	path: string,
	message: string,
): SchemaV1ValidationResult<T> => ({
	ok: false,
	error: { code, path, message },
});

function error(
	code: SchemaV1ValidationCode,
	path: string,
	message: string,
): SchemaV1ValidationError {
	return { code, path, message };
}

function fieldPath(path: string, field: string): string {
	return `${path}/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function indexPath(path: string, index: number): string {
	return `${path}/${index}`;
}

function invalidType(
	path: string,
	description: string,
): SchemaV1ValidationError {
	return error('invalid-type', path, `${description} has an invalid type`);
}

function containsForbiddenControl(input: string): boolean {
	return Array.from(input).some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return (code >= 0 && code <= 0x1f) || code === 0x7f;
	});
}

function inspectRecord(
	input: unknown,
	path: string,
	allowed: readonly string[],
	required: readonly string[],
): RecordView | SchemaV1ValidationError {
	try {
		if (input === null || typeof input !== 'object' || Array.isArray(input))
			return invalidType(path, 'object');

		const objectInput = input;
		const prototype = Reflect.getPrototypeOf(objectInput);
		if (prototype !== Object.prototype && prototype !== null)
			return invalidType(path, 'object');

		const ownKeys = Reflect.ownKeys(objectInput);
		for (const symbol of ownKeys.filter(
			(key): key is symbol => typeof key === 'symbol',
		)) {
			const descriptor = Object.getOwnPropertyDescriptor(
				objectInput,
				symbol,
			);
			if (descriptor?.enumerable)
				return invalidType(path, 'object with enumerable symbol keys');
		}

		const keys = Object.keys(objectInput).sort();
		const unknown = keys.find((key) => !allowed.includes(key));
		if (unknown)
			return error(
				'unexpected-field',
				fieldPath(path, unknown),
				'unexpected field',
			);

		const missing = required.find((key) => !keys.includes(key));
		if (missing)
			return error(
				'missing-field',
				fieldPath(path, missing),
				`required field ${missing} is missing`,
			);

		return {
			input: objectInput,
			keys,
			hasOwnKeys: ownKeys.length > 0,
		};
	} catch {
		return invalidType(path, 'object');
	}
}

function hasField(view: RecordView, field: string): boolean {
	return view.keys.includes(field);
}

function readField(
	view: RecordView,
	field: string,
	path: string,
): SchemaV1ValidationResult<unknown> {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(view.input, field);
		if (!descriptor || !('value' in descriptor))
			return failure(
				'invalid-type',
				fieldPath(path, field),
				'property has an invalid type',
			);
		return success(descriptor.value);
	} catch {
		return failure(
			'invalid-type',
			fieldPath(path, field),
			'property has an invalid type',
		);
	}
}

function validateArray(
	input: unknown,
	path: string,
): readonly unknown[] | SchemaV1ValidationError {
	try {
		if (!Array.isArray(input)) return invalidType(path, 'array');

		const array = input as unknown[];
		if (Object.getPrototypeOf(array) !== Array.prototype)
			return invalidType(path, 'array');
		const length = array.length;
		for (const symbol of Object.getOwnPropertySymbols(array)) {
			const descriptor = Object.getOwnPropertyDescriptor(array, symbol);
			if (descriptor?.enumerable)
				return invalidType(path, 'array with enumerable symbol keys');
		}
		const keys = Object.keys(array).sort();
		const unexpected = keys.find((key) => {
			if (!/^\d+$/.test(key)) return true;
			const index = Number(key);
			return (
				String(index) !== key ||
				!Number.isSafeInteger(index) ||
				index >= length
			);
		});
		if (unexpected)
			return error(
				'unexpected-field',
				fieldPath(path, unexpected),
				'unexpected array field',
			);
		const values: unknown[] = [];
		for (let index = 0; index < length; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(
				array,
				String(index),
			);
			if (!descriptor || !('value' in descriptor))
				return invalidType(indexPath(path, index), 'array item');
			values.push(descriptor.value);
		}
		return values;
	} catch {
		return invalidType(path, 'array');
	}
}

function isUnpairedSurrogate(input: string): boolean {
	for (let index = 0; index < input.length; index += 1) {
		const code = input.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = input.charCodeAt(index + 1);
			if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff)
				return true;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

function canonicalizeNotePath(
	input: unknown,
): SchemaV1ValidationResult<string> {
	if (
		typeof input !== 'string' ||
		input.length === 0 ||
		containsForbiddenControl(input) ||
		isUnpairedSurrogate(input) ||
		input.startsWith('/') ||
		input.startsWith('\\') ||
		/^[A-Za-z]:/.test(input) ||
		input.endsWith('/') ||
		input.endsWith('\\')
	)
		return failure('invalid-note-path', '', 'note path is invalid');

	const parts = input.replaceAll('\\', '/').split('/');
	const normalized: string[] = [];
	for (const part of parts) {
		if (part === '..')
			return failure('invalid-note-path', '', 'note path is invalid');
		if (part === '' || part === '.') continue;
		normalized.push(part);
	}
	const result = normalized.join('/');
	if (!result || !result.endsWith('.md'))
		return failure('invalid-note-path', '', 'note path is invalid');
	return success(result);
}

export function canonicalizeDraftNotePath(
	input: unknown,
): SchemaV1ValidationResult<string> {
	return canonicalizeNotePath(input);
}

function validatePersistedNotePath(
	input: unknown,
	path: string,
): SchemaV1ValidationResult<string> {
	const canonical = canonicalizeNotePath(input);
	if (!canonical.ok)
		return failure('invalid-note-path', path, 'note path is invalid');
	if (canonical.value !== input)
		return failure(
			'noncanonical-note-path',
			path,
			'note path is not canonical',
		);
	return canonical;
}

function validateProviderTimestamp(
	input: unknown,
	path: string,
): SchemaV1ValidationResult<string> {
	const canonical = canonicalizeTimestamp(input);
	if (!canonical.ok)
		return failure(
			'invalid-provider-timestamp',
			path,
			'provider timestamp is invalid',
		);
	if (canonical.value !== input)
		return failure(
			'noncanonical-provider-timestamp',
			path,
			'provider timestamp is not canonical',
		);
	return success(input as string);
}

function validatePluginTimestamp(
	input: unknown,
	path: string,
): SchemaV1ValidationResult<string> {
	const canonical = canonicalizeTimestamp(input);
	if (!canonical.ok)
		return failure(
			'invalid-plugin-timestamp',
			path,
			'plugin timestamp is invalid',
		);
	if (typeof input !== 'string' || !PLUGIN_TIMESTAMP.test(input))
		return failure(
			'noncanonical-plugin-timestamp',
			path,
			'plugin timestamp is not canonical',
		);
	return success(input);
}

function validateOptionalPluginTimestamp(
	view: RecordView,
	field: string,
	path: string,
): SchemaV1ValidationResult<string | undefined> {
	if (!hasField(view, field)) return success(undefined);
	const value = readField(view, field, path);
	if (!value.ok) return value;
	return validatePluginTimestamp(value.value, fieldPath(path, field));
}

function validateSeenEvents(
	input: unknown,
	path: string,
): SchemaV1ValidationResult<SeenEventV1[]> {
	const array = validateArray(input, path);
	if (isValidationError(array)) return { ok: false, error: array };
	const events: SeenEventV1[] = [];
	for (let index = 0; index < array.length; index += 1) {
		const eventPath = indexPath(path, index);
		const view = inspectRecord(
			array[index],
			eventPath,
			['id', 'createdAt'],
			['id', 'createdAt'],
		);
		if (!('input' in view)) return { ok: false, error: view };
		const eventIdValue = readField(view, 'id', eventPath);
		if (!eventIdValue.ok) return eventIdValue;
		const eventId = eventIdValue.value;
		if (typeof eventId !== 'string' || !canonicalizeEventId(eventId).ok)
			return failure(
				'invalid-provider-event-id',
				fieldPath(eventPath, 'id'),
				'provider event ID is invalid',
			);
		const createdAtValue = readField(view, 'createdAt', eventPath);
		if (!createdAtValue.ok) return createdAtValue;
		const createdAt = validateProviderTimestamp(
			createdAtValue.value,
			fieldPath(eventPath, 'createdAt'),
		);
		if (!createdAt.ok) return createdAt;
		events.push({ id: eventId, createdAt: createdAt.value });
	}

	const seen = new Set<string>();
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		if (!event) continue;
		if (seen.has(event.id))
			return failure(
				'duplicate-seen-event-id',
				fieldPath(indexPath(path, index), 'id'),
				'duplicate provider event ID',
			);
		seen.add(event.id);
	}
	return success(events);
}

function validateGitHubState(
	input: unknown,
	path: string,
): SchemaV1ValidationResult<GitHubSyncStateV1> {
	const view = inspectRecord(input, path, ['pollNotBefore'], []);
	if (!('input' in view)) return { ok: false, error: view };
	const pollNotBefore = validateOptionalPluginTimestamp(
		view,
		'pollNotBefore',
		path,
	);
	if (!pollNotBefore.ok) return pollNotBefore;
	return success(
		pollNotBefore.value === undefined
			? {}
			: { pollNotBefore: pollNotBefore.value },
	);
}

function validateSyncState(
	input: unknown,
	path: string,
): SchemaV1ValidationResult<PersonSyncState> {
	const view = inspectRecord(
		input,
		path,
		['lastAttemptAt', 'lastSuccessfulSyncAt', 'seenEvents', 'github'],
		['seenEvents', 'github'],
	);
	if (!('input' in view)) return { ok: false, error: view };
	const lastAttemptAt = validateOptionalPluginTimestamp(
		view,
		'lastAttemptAt',
		path,
	);
	if (!lastAttemptAt.ok) return lastAttemptAt;
	const lastSuccessfulSyncAt = validateOptionalPluginTimestamp(
		view,
		'lastSuccessfulSyncAt',
		path,
	);
	if (!lastSuccessfulSyncAt.ok) return lastSuccessfulSyncAt;
	const seenEventsValue = readField(view, 'seenEvents', path);
	if (!seenEventsValue.ok) return seenEventsValue;
	const seenEvents = validateSeenEvents(
		seenEventsValue.value,
		fieldPath(path, 'seenEvents'),
	);
	if (!seenEvents.ok) return seenEvents;
	const githubValue = readField(view, 'github', path);
	if (!githubValue.ok) return githubValue;
	const github = validateGitHubState(
		githubValue.value,
		fieldPath(path, 'github'),
	);
	if (!github.ok) return github;
	return success({
		...(lastAttemptAt.value === undefined
			? {}
			: { lastAttemptAt: lastAttemptAt.value }),
		...(lastSuccessfulSyncAt.value === undefined
			? {}
			: { lastSuccessfulSyncAt: lastSuccessfulSyncAt.value }),
		seenEvents: seenEvents.value,
		github: github.value,
	});
}

function validateTrackingStart(
	input: unknown,
	path: string,
	currentInstant: string,
): SchemaV1ValidationResult<TrackingStart> {
	const view = inspectRecord(input, path, ['mode', 'at'], ['mode']);
	if (!('input' in view)) return { ok: false, error: view };
	const modeValue = readField(view, 'mode', path);
	if (!modeValue.ok) return modeValue;
	const mode = modeValue.value;
	if (
		mode !== 'from-now' &&
		mode !== 'available-recent' &&
		mode !== 'from-date'
	)
		return failure(
			'invalid-tracking-start',
			fieldPath(path, 'mode'),
			'tracking start mode is invalid',
		);
	if (mode === 'available-recent') {
		if (hasField(view, 'at'))
			return failure(
				'invalid-tracking-start',
				path,
				'available-recent tracking start cannot contain at',
			);
		return success({ mode });
	}
	if (!hasField(view, 'at'))
		return failure(
			'missing-field',
			fieldPath(path, 'at'),
			'required field at is missing',
		);
	const atValue = readField(view, 'at', path);
	if (!atValue.ok) return atValue;
	const at = validatePluginTimestamp(atValue.value, fieldPath(path, 'at'));
	if (!at.ok) return at;
	if (mode === 'from-date' && at.value > currentInstant)
		return failure(
			'future-from-date',
			fieldPath(path, 'at'),
			'from-date cannot be in the future',
		);
	return success({ mode, at: at.value });
}

function validateFollowedPerson(
	input: unknown,
	path: string,
	currentInstant: string,
): SchemaV1ValidationResult<FollowedPersonV1> {
	const view = inspectRecord(
		input,
		path,
		[
			'username',
			'githubAccountId',
			'notePath',
			'trackingStart',
			'syncState',
		],
		[
			'username',
			'githubAccountId',
			'notePath',
			'trackingStart',
			'syncState',
		],
	);
	if (!('input' in view)) return { ok: false, error: view };
	const username = readField(view, 'username', path);
	if (!username.ok) return username;
	if (!isCanonicalGitHubUsername(username.value))
		return failure(
			'invalid-username',
			fieldPath(path, 'username'),
			'username is invalid',
		);
	const githubAccountId = readField(view, 'githubAccountId', path);
	if (!githubAccountId.ok) return githubAccountId;
	if (!isCanonicalPositiveDecimalString(githubAccountId.value))
		return failure(
			'invalid-github-account-id',
			fieldPath(path, 'githubAccountId'),
			'GitHub account ID is invalid',
		);
	const notePathValue = readField(view, 'notePath', path);
	if (!notePathValue.ok) return notePathValue;
	const notePath = validatePersistedNotePath(
		notePathValue.value,
		fieldPath(path, 'notePath'),
	);
	if (!notePath.ok) return notePath;
	const trackingStartValue = readField(view, 'trackingStart', path);
	if (!trackingStartValue.ok) return trackingStartValue;
	const trackingStart = validateTrackingStart(
		trackingStartValue.value,
		fieldPath(path, 'trackingStart'),
		currentInstant,
	);
	if (!trackingStart.ok) return trackingStart;
	const syncStateValue = readField(view, 'syncState', path);
	if (!syncStateValue.ok) return syncStateValue;
	const syncState = validateSyncState(
		syncStateValue.value,
		fieldPath(path, 'syncState'),
	);
	if (!syncState.ok) return syncState;
	return success({
		username: username.value,
		githubAccountId: githubAccountId.value,
		notePath: notePath.value,
		trackingStart: trackingStart.value,
		syncState: syncState.value,
	});
}

function validatePolicy(
	input: unknown,
	path: string,
): SchemaV1ValidationResult<GitHubRequestPolicyV1> {
	const view = inspectRecord(input, path, ['rateLimitNotBefore'], []);
	if (!('input' in view)) return { ok: false, error: view };
	const rateLimitNotBefore = validateOptionalPluginTimestamp(
		view,
		'rateLimitNotBefore',
		path,
	);
	if (!rateLimitNotBefore.ok) return rateLimitNotBefore;
	return success(
		rateLimitNotBefore.value === undefined
			? {}
			: { rateLimitNotBefore: rateLimitNotBefore.value },
	);
}

function validateUniqueness(
	people: readonly FollowedPersonV1[],
): SchemaV1ValidationError | undefined {
	const usernames = new Set<string>();
	for (let index = 0; index < people.length; index += 1) {
		const person = people[index];
		if (!person) continue;
		const key = person.username.toLowerCase();
		if (usernames.has(key))
			return error(
				'duplicate-username',
				fieldPath(indexPath('/followedPeople', index), 'username'),
				'duplicate username',
			);
		usernames.add(key);
	}

	const accountIds = new Set<string>();
	for (let index = 0; index < people.length; index += 1) {
		const person = people[index];
		if (!person) continue;
		if (accountIds.has(person.githubAccountId))
			return error(
				'duplicate-github-account-id',
				fieldPath(
					indexPath('/followedPeople', index),
					'githubAccountId',
				),
				'duplicate GitHub account ID',
			);
		accountIds.add(person.githubAccountId);
	}

	const notePaths = new Set<string>();
	for (let index = 0; index < people.length; index += 1) {
		const person = people[index];
		if (!person) continue;
		const key = person.notePath.toLowerCase();
		if (notePaths.has(key))
			return error(
				'duplicate-note-path',
				fieldPath(indexPath('/followedPeople', index), 'notePath'),
				'duplicate note path',
			);
		notePaths.add(key);
	}
	return undefined;
}

export function createEmptySettingsV1(): DevRadarSettingsV1 {
	return { schemaVersion: 1, followedPeople: [] };
}

export function createEmptyPersonSyncState(): PersonSyncState {
	return { seenEvents: [], github: {} };
}

export function validatePersistedSettingsV1(
	input: unknown,
	currentInstant: string,
): SchemaV1ValidationResult<DevRadarSettingsV1> {
	const current = validatePluginTimestamp(currentInstant, '');
	if (!current.ok) return current;
	if (input === undefined) return success(createEmptySettingsV1());

	const view = inspectRecord(
		input,
		'',
		['schemaVersion', 'followedPeople', 'githubRequestPolicy'],
		[],
	);
	if (!('input' in view)) return { ok: false, error: view };
	if (view.keys.length === 0 && !view.hasOwnKeys)
		return success(createEmptySettingsV1());
	const missing = ['schemaVersion', 'followedPeople'].find(
		(field) => !hasField(view, field),
	);
	if (missing)
		return failure(
			'missing-field',
			fieldPath('', missing),
			`required field ${missing} is missing`,
		);

	const schemaVersionValue = readField(view, 'schemaVersion', '');
	if (!schemaVersionValue.ok) return schemaVersionValue;
	const schemaVersion = schemaVersionValue.value;
	if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion))
		return failure(
			'invalid-schema-version',
			'/schemaVersion',
			'schema version is invalid',
		);
	if (schemaVersion !== 1)
		return failure(
			schemaVersion > 1
				? 'unsupported-schema-version'
				: 'invalid-schema-version',
			'/schemaVersion',
			schemaVersion > 1
				? 'schema version is unsupported'
				: 'schema version is invalid',
		);

	const followedPeopleValue = readField(view, 'followedPeople', '');
	if (!followedPeopleValue.ok) return followedPeopleValue;
	const peopleArray = validateArray(
		followedPeopleValue.value,
		'/followedPeople',
	);
	if (isValidationError(peopleArray))
		return { ok: false, error: peopleArray };
	const people: FollowedPersonV1[] = [];
	for (let index = 0; index < peopleArray.length; index += 1) {
		const person = validateFollowedPerson(
			peopleArray[index],
			indexPath('/followedPeople', index),
			current.value,
		);
		if (!person.ok) return person;
		people.push(person.value);
	}

	let githubRequestPolicy: GitHubRequestPolicyV1 | undefined;
	if (hasField(view, 'githubRequestPolicy')) {
		const policyValue = readField(view, 'githubRequestPolicy', '');
		if (!policyValue.ok) return policyValue;
		const policy = validatePolicy(
			policyValue.value,
			'/githubRequestPolicy',
		);
		if (!policy.ok) return policy;
		githubRequestPolicy = policy.value;
	}

	const uniqueness = validateUniqueness(people);
	if (uniqueness) return { ok: false, error: uniqueness };
	return success({
		schemaVersion: 1,
		followedPeople: people,
		...(githubRequestPolicy === undefined ? {} : { githubRequestPolicy }),
	});
}
