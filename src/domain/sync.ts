import {
	compareActivities,
	compareCanonicalTimestamps,
	type Activity,
	type CanonicalEventId,
} from './activity';
import {
	renderActivityEntry,
	type ManagedActivityEntry,
	type RetainedActivityEntry,
} from './person-note';
import {
	type CanonicalPluginTimestamp,
	type PersonSyncState,
} from './settings';

export type SyncDomainError =
	| {
			readonly kind: 'conflicting-provider-activity';
			readonly providerEventId: CanonicalEventId;
	  }
	| {
			readonly kind: 'seen-event-timestamp-mismatch';
			readonly providerEventId: CanonicalEventId;
			readonly persistedCreatedAt: string;
			readonly activityTimestamp: string;
	  }
	| {
			readonly kind: 'unconfirmed-accounting';
			readonly providerEventId: CanonicalEventId;
	  };

export type SyncResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: SyncDomainError };

export type ReconciliationInput = {
	readonly activities: readonly Activity[];
	readonly state: PersonSyncState;
	readonly retainedEntries: readonly RetainedActivityEntry[];
};

export type ReconciliationPlan = {
	readonly priorSeenEventIds: readonly CanonicalEventId[];
	readonly reconciledActivities: readonly Activity[];
	readonly newActivities: readonly Activity[];
	readonly retainedEntries: readonly RetainedActivityEntry[];
	readonly finalEntries: readonly ManagedActivityEntry[];
	readonly accountingCandidates: readonly Activity[];
};

export type ConfirmedAccounting = {
	readonly kind: 'confirmed-accounting';
	readonly activities: readonly Activity[];
};

const success = <T>(value: T): SyncResult<T> => ({ ok: true, value });

const failure = <T>(error: SyncDomainError): SyncResult<T> => ({
	ok: false,
	error,
});

function activitiesEqual(left: Activity, right: Activity): boolean {
	if (
		left.family !== right.family ||
		left.action !== right.action ||
		left.providerEventId !== right.providerEventId ||
		left.timestamp !== right.timestamp ||
		left.repository !== right.repository
	)
		return false;
	if (left.family === 'push' && right.family === 'push')
		return (
			left.ref === right.ref && left.pushSourceUrl === right.pushSourceUrl
		);
	if (left.family === 'pull-request' && right.family === 'pull-request')
		return (
			left.number === right.number &&
			left.title === right.title &&
			left.sourceUrl === right.sourceUrl
		);
	if (left.family === 'issue' && right.family === 'issue')
		return (
			left.number === right.number &&
			left.title === right.title &&
			left.sourceUrl === right.sourceUrl
		);
	return false;
}

function uniqueActivities(
	input: readonly Activity[],
): SyncResult<readonly Activity[]> {
	const byId = new Map<string, Activity>();
	for (const activity of input) {
		const existing = byId.get(activity.providerEventId);
		if (existing && !activitiesEqual(existing, activity))
			return {
				ok: false,
				error: {
					kind: 'conflicting-provider-activity',
					providerEventId: activity.providerEventId,
				},
			};
		byId.set(activity.providerEventId, existing ?? activity);
	}
	return { ok: true, value: [...byId.values()] };
}

function sortRetainedEntries(
	entries: readonly RetainedActivityEntry[],
): RetainedActivityEntry[] {
	return entries
		.map((entry) => ({ ...entry }))
		.sort(
			(left, right) =>
				-compareCanonicalTimestamps(left.timestamp, right.timestamp),
		);
}

function mergeEntries(
	retainedEntries: readonly RetainedActivityEntry[],
	newActivities: readonly Activity[],
): ManagedActivityEntry[] {
	const retained = sortRetainedEntries(retainedEntries);
	const created = newActivities.slice();
	const merged: ManagedActivityEntry[] = [];
	let retainedIndex = 0;
	let newIndex = 0;
	while (retainedIndex < retained.length || newIndex < created.length) {
		const retainedEntry = retained[retainedIndex];
		const newActivity = created[newIndex];
		if (!retainedEntry) {
			if (newActivity)
				merged.push({ kind: 'new', activity: newActivity });
			newIndex += 1;
			continue;
		}
		if (!newActivity) {
			merged.push({ kind: 'retained', entry: retainedEntry });
			retainedIndex += 1;
			continue;
		}
		const timestampOrder = compareCanonicalTimestamps(
			retainedEntry.timestamp,
			newActivity.timestamp,
		);
		if (timestampOrder >= 0) {
			merged.push({ kind: 'retained', entry: retainedEntry });
			retainedIndex += 1;
		} else {
			merged.push({ kind: 'new', activity: newActivity });
			newIndex += 1;
		}
	}
	return merged;
}

export function reconcileActivities(
	input: ReconciliationInput,
): SyncResult<ReconciliationPlan> {
	const unique = uniqueActivities(input.activities);
	if (!unique.ok) return unique;
	const activities = unique.value;
	const seen = new Map(
		input.state.seenEvents.map((event) => [event.id, event]),
	);
	const priorSeenEventIds: CanonicalEventId[] = [];
	const unseen: Activity[] = [];
	for (const activity of activities) {
		const prior = seen.get(activity.providerEventId);
		if (!prior) {
			unseen.push(activity);
			continue;
		}
		if (prior.createdAt !== activity.timestamp)
			return failure({
				kind: 'seen-event-timestamp-mismatch',
				providerEventId: activity.providerEventId,
				persistedCreatedAt: prior.createdAt,
				activityTimestamp: activity.timestamp,
			});
		priorSeenEventIds.push(activity.providerEventId);
	}
	priorSeenEventIds.sort();
	const orderedUnseen = unseen.slice().sort(compareActivities);
	const available = input.retainedEntries.map((entry) => ({
		entry: { ...entry },
		used: false,
	}));
	const reconciledActivities: Activity[] = [];
	const newActivities: Activity[] = [];
	for (const activity of orderedUnseen) {
		const markdown = renderActivityEntry(activity);
		const match = available.find(
			(candidate) =>
				!candidate.used && candidate.entry.markdown === markdown,
		);
		if (match) {
			match.used = true;
			reconciledActivities.push(activity);
		} else newActivities.push(activity);
	}
	return success({
		priorSeenEventIds,
		reconciledActivities,
		newActivities,
		retainedEntries: sortRetainedEntries(input.retainedEntries),
		finalEntries: mergeEntries(input.retainedEntries, newActivities),
		accountingCandidates: [...reconciledActivities, ...newActivities],
	});
}

export function confirmAccounting(
	currentEntries: readonly RetainedActivityEntry[],
	activities: readonly Activity[],
): SyncResult<ConfirmedAccounting> {
	const unique = uniqueActivities(activities);
	if (!unique.ok) return unique;
	const available = currentEntries.map((entry) => ({
		entry,
		used: false,
	}));
	const ordered = unique.value.slice().sort(compareActivities);
	for (const activity of ordered) {
		const markdown = renderActivityEntry(activity);
		const match = available.find(
			(candidate) =>
				!candidate.used && candidate.entry.markdown === markdown,
		);
		if (!match)
			return failure({
				kind: 'unconfirmed-accounting',
				providerEventId: activity.providerEventId,
			});
		match.used = true;
	}
	return success({
		kind: 'confirmed-accounting',
		activities: ordered,
	});
}

function mergePollNotBefore(
	current: string | undefined,
	observed: CanonicalPluginTimestamp | undefined,
): string | undefined {
	if (!observed) return current;
	if (!current || compareCanonicalTimestamps(observed, current) > 0)
		return observed;
	return current;
}

export function applySuccessfulSyncTransition(
	previous: PersonSyncState,
	confirmation: ConfirmedAccounting,
	options: {
		readonly completedAt: CanonicalPluginTimestamp;
		readonly lastAttemptAt?: CanonicalPluginTimestamp;
		readonly pollNotBefore?: CanonicalPluginTimestamp;
	},
): SyncResult<PersonSyncState> {
	const unique = uniqueActivities(confirmation.activities);
	if (!unique.ok) return unique;
	const existing = new Map(
		previous.seenEvents.map((event) => [event.id, event.createdAt]),
	);
	const additions = unique.value.slice().sort(compareActivities);
	const seenEvents = previous.seenEvents.map((event) => ({ ...event }));
	for (const activity of additions) {
		const priorCreatedAt = existing.get(activity.providerEventId);
		if (priorCreatedAt !== undefined) {
			if (priorCreatedAt !== activity.timestamp)
				return failure({
					kind: 'seen-event-timestamp-mismatch',
					providerEventId: activity.providerEventId,
					persistedCreatedAt: priorCreatedAt,
					activityTimestamp: activity.timestamp,
				});
			continue;
		}
		seenEvents.push({
			id: activity.providerEventId,
			createdAt: activity.timestamp,
		});
		existing.set(activity.providerEventId, activity.timestamp);
	}
	const lastAttemptAt = options.lastAttemptAt ?? previous.lastAttemptAt;
	const pollNotBefore = mergePollNotBefore(
		previous.github.pollNotBefore,
		options.pollNotBefore,
	);
	return success({
		...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
		lastSuccessfulSyncAt: options.completedAt,
		seenEvents,
		github: {
			...(pollNotBefore === undefined ? {} : { pollNotBefore }),
		},
	});
}

export function applyFailedSyncTransition(
	previous: PersonSyncState,
	options: {
		readonly lastAttemptAt?: CanonicalPluginTimestamp;
		readonly pollNotBefore?: CanonicalPluginTimestamp;
	},
): SyncResult<PersonSyncState> {
	const lastAttemptAt = options.lastAttemptAt ?? previous.lastAttemptAt;
	const pollNotBefore = mergePollNotBefore(
		previous.github.pollNotBefore,
		options.pollNotBefore,
	);
	return success({
		...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
		...(previous.lastSuccessfulSyncAt === undefined
			? {}
			: { lastSuccessfulSyncAt: previous.lastSuccessfulSyncAt }),
		seenEvents: previous.seenEvents.map((event) => ({ ...event })),
		github: pollNotBefore === undefined ? {} : { pollNotBefore },
	});
}
