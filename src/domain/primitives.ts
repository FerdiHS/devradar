const USERNAME =
	/^(?=.{1,39}$)(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;

export function isCanonicalGitHubUsername(value: unknown): value is string {
	return typeof value === 'string' && USERNAME.test(value);
}

export function isCanonicalPositiveDecimalString(
	value: unknown,
): value is string {
	return typeof value === 'string' && POSITIVE_DECIMAL.test(value);
}
