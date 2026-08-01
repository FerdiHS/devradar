const REQUIRED_CHECK_NAMES = [
	'Quality checks - Node.js 22.x',
	'Quality checks - Node.js 24.x',
];

function reject(reason) {
	return { decision: 'reject', reason };
}

function isNonEmptyString(value) {
	return typeof value === 'string' && value.trim().length > 0;
}

function parseTimestamp(timestamp) {
	const milliseconds = Date.parse(timestamp ?? '');

	return Number.isNaN(milliseconds) ? undefined : milliseconds;
}

function checkRunTimestamp(checkRun) {
	const timestamp =
		checkRun.completed_at ?? checkRun.started_at ?? checkRun.created_at;

	return parseTimestamp(timestamp);
}

function latestCheckRunsByName(checkRuns) {
	const latestRuns = new Map();

	for (const checkRun of checkRuns) {
		if (!isNonEmptyString(checkRun?.name)) {
			return undefined;
		}

		const timestamp = checkRunTimestamp(checkRun);
		if (timestamp === undefined) {
			return undefined;
		}

		const latest = latestRuns.get(checkRun.name);
		if (!latest || timestamp >= latest.timestamp) {
			latestRuns.set(checkRun.name, { checkRun, timestamp });
		}
	}

	return latestRuns;
}

function latestStatusesByContext(statuses) {
	const latestStatuses = new Map();

	for (const status of statuses) {
		if (!isNonEmptyString(status?.context)) {
			return undefined;
		}

		const timestamp = parseTimestamp(
			status.updated_at ?? status.created_at,
		);
		if (timestamp === undefined) {
			return undefined;
		}

		const latest = latestStatuses.get(status.context);
		if (!latest || timestamp > latest.timestamp) {
			latestStatuses.set(status.context, { status, timestamp });
		}
	}

	return latestStatuses;
}

export function evaluateReleaseApproval({
	action,
	labelName,
	actorLogin,
	repository,
	baseRef,
	headRepository,
	headRef,
	headSha,
	authorLogin,
	draft,
	body,
	releasePleaseAppSlug,
	checkRuns,
	statuses,
	selfCheckName = 'Approve Release Please',
}) {
	if (action !== 'labeled') {
		return { decision: 'invalidate' };
	}

	if (labelName !== 'release: ready') {
		return { decision: 'ignore' };
	}

	if (actorLogin !== 'FerdiHS') {
		return reject(
			'Only FerdiHS can approve a Release Please pull request.',
		);
	}

	if (!isNonEmptyString(repository) || !isNonEmptyString(headSha)) {
		return reject('The pull request repository or head SHA is missing.');
	}

	if (baseRef !== 'main') {
		return reject('The pull request must target main.');
	}

	if (headRepository !== repository) {
		return reject('The pull request must come from this repository.');
	}

	if (headRef !== 'release-please--branches--main--components--devradar') {
		return reject('The pull request is not the Release Please branch.');
	}

	if (!isNonEmptyString(releasePleaseAppSlug)) {
		return reject('The Release Please App slug is not configured.');
	}

	if (authorLogin !== `${releasePleaseAppSlug}[bot]`) {
		return reject(
			'The pull request was not authored by the Release Please App.',
		);
	}

	if (draft !== false) {
		return reject('The pull request must not be a draft.');
	}

	if (
		typeof body !== 'string' ||
		!body.includes('This PR was generated with Release Please.')
	) {
		return reject('The pull request is missing the Release Please marker.');
	}

	if (!Array.isArray(checkRuns) || !Array.isArray(statuses)) {
		return reject('The pull request checks could not be read.');
	}

	const latestRuns = latestCheckRunsByName(checkRuns);
	if (!latestRuns) {
		return reject('A check run is missing a name or timestamp.');
	}

	const latestStatuses = latestStatusesByContext(statuses);
	if (!latestStatuses) {
		return reject('A commit status is missing a context or timestamp.');
	}

	for (const name of REQUIRED_CHECK_NAMES) {
		const latest = latestRuns.get(name)?.checkRun;
		if (
			!latest ||
			latest.status !== 'completed' ||
			latest.conclusion !== 'success'
		) {
			return reject(`${name} must complete successfully.`);
		}
	}

	for (const [name, { checkRun }] of latestRuns) {
		if (name === selfCheckName) {
			continue;
		}

		if (
			checkRun.status !== 'completed' ||
			checkRun.conclusion !== 'success'
		) {
			return reject(`Check run ${name} must complete successfully.`);
		}
	}

	for (const { status } of latestStatuses.values()) {
		if (status?.state !== 'success') {
			return reject('All commit statuses must succeed.');
		}
	}

	return { decision: 'approve' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const input = await new Promise((resolve, rejectInput) => {
		let content = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (chunk) => {
			content += chunk;
		});
		process.stdin.on('end', () => resolve(content));
		process.stdin.on('error', rejectInput);
	});

	process.stdout.write(
		`${JSON.stringify(evaluateReleaseApproval(JSON.parse(input)))}\n`,
	);
}
