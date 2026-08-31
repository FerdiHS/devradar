import { Platform, requestUrl } from 'obsidian';
import {
	canonicalizeRepository,
	canonicalizePositiveNumber,
} from '../domain/activity';
import { isCanonicalGitHubUsername } from '../domain/primitives';
import type {
	GitHubTransport,
	GitHubTransportRequest,
	GitHubTransportResponse,
} from './github';
import { GitHubTransportContractError } from './github';

const API_ORIGIN = 'https://api.github.com';
const ACCEPT_HEADER = 'application/vnd.github+json';
const API_VERSION_HEADER = '2026-03-10';
const EVENTS_QUERY =
	/^(?:\?per_page=100|\?page=[23]&per_page=100|\?per_page=100&page=[23])$/;

function isApprovedRequestUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (
		url.toString() !== value ||
		url.origin !== API_ORIGIN ||
		url.username !== '' ||
		url.password !== '' ||
		url.hash !== '' ||
		value.includes('#')
	)
		return false;
	const parts = url.pathname.split('/');
	if (
		parts.length === 3 &&
		parts[1] === 'users' &&
		isCanonicalGitHubUsername(parts[2])
	)
		return url.search === '' && !value.includes('?');
	if (
		parts.length === 6 &&
		parts[1] === 'repos' &&
		parts[2] !== undefined &&
		parts[3] !== undefined &&
		parts[4] === 'pulls' &&
		parts[5] !== undefined &&
		canonicalizeRepository(`${parts[2]}/${parts[3]}`).ok &&
		canonicalizePositiveNumber(parts[5]).ok
	)
		return url.search === '' && !value.includes('?');
	if (
		parts.length !== 5 ||
		parts[1] !== 'users' ||
		!isCanonicalGitHubUsername(parts[2]) ||
		parts[3] !== 'events' ||
		parts[4] !== 'public'
	)
		return false;
	return EVENTS_QUERY.test(url.search);
}

function hasInvalidRequestHeaders(
	headers: Readonly<Record<string, string>>,
	pluginVersion: string,
): boolean {
	const expectedHeaders = new Map([
		['accept', ACCEPT_HEADER],
		[
			'user-agent',
			`DevRadar/${pluginVersion} (https://github.com/FerdiHS/devradar)`,
		],
		['x-github-api-version', API_VERSION_HEADER],
	]);
	const seenHeaders = new Set<string>();
	for (const [header, value] of Object.entries(headers)) {
		const normalizedHeader = header.toLowerCase();
		const expectedValue = expectedHeaders.get(normalizedHeader);
		if (
			expectedValue === undefined ||
			seenHeaders.has(normalizedHeader) ||
			value !== expectedValue
		)
			return true;
		seenHeaders.add(normalizedHeader);
	}
	return seenHeaders.size !== expectedHeaders.size;
}

function assertApprovedRequest(
	request: GitHubTransportRequest,
	pluginVersion: string,
): void {
	if (Platform.isMobileApp)
		throw new GitHubTransportContractError(
			'GitHub transport is unavailable on Obsidian Mobile',
		);
	if (
		!isApprovedRequestUrl(request.url) ||
		hasInvalidRequestHeaders(request.headers, pluginVersion)
	)
		throw new GitHubTransportContractError(
			'GitHub request is outside the approved unauthenticated endpoint scope',
		);
}

/**
 * Production-only Obsidian boundary. The provider adapter remains pure and
 * testable by receiving this transport as an injected dependency. Redirect
 * handling follows the accepted endpoint-scope contract documented in
 * docs/github.md; the supported response type does not expose final URL/origin
 * information.
 */
export function createObsidianGitHubTransport(
	pluginVersion: string,
): GitHubTransport {
	return async (
		request: GitHubTransportRequest,
	): Promise<GitHubTransportResponse> => {
		assertApprovedRequest(request, pluginVersion);
		const response = await requestUrl({
			url: request.url,
			method: 'GET',
			headers: { ...request.headers },
			throw: false,
		});
		const text = response.text;
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
		return {
			status: response.status,
			headers: response.headers,
			json,
		};
	};
}
