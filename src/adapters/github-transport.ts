import { Platform, requestUrl } from 'obsidian';
import { isCanonicalGitHubUsername } from '../domain/primitives';
import type {
	GitHubTransport,
	GitHubTransportRequest,
	GitHubTransportResponse,
} from './github';
import { GitHubTransportContractError } from './github';

const API_ORIGIN = 'https://api.github.com';
const APPROVED_REQUEST_HEADERS = new Set([
	'accept',
	'user-agent',
	'x-github-api-version',
]);
const EVENTS_QUERY =
	/^(?:\?per_page=100|\?page=[1-9]\d*&per_page=100|\?per_page=100&page=[1-9]\d*)$/;

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
		url.hash !== ''
	)
		return false;
	const parts = url.pathname.split('/');
	if (
		parts.length === 3 &&
		parts[1] === 'users' &&
		isCanonicalGitHubUsername(parts[2])
	)
		return url.search === '';
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

function hasUnapprovedHeader(
	headers: Readonly<Record<string, string>>,
): boolean {
	return Object.keys(headers).some(
		(header) => !APPROVED_REQUEST_HEADERS.has(header.toLowerCase()),
	);
}

function assertApprovedRequest(request: GitHubTransportRequest): void {
	if (Platform.isMobile)
		throw new GitHubTransportContractError(
			'GitHub transport is unavailable on Obsidian Mobile',
		);
	if (
		!isApprovedRequestUrl(request.url) ||
		hasUnapprovedHeader(request.headers)
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
export function createObsidianGitHubTransport(): GitHubTransport {
	return async (
		request: GitHubTransportRequest,
	): Promise<GitHubTransportResponse> => {
		assertApprovedRequest(request);
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
