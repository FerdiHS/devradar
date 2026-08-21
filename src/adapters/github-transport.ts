import { requestUrl } from 'obsidian';
import type {
	GitHubTransport,
	GitHubTransportRequest,
	GitHubTransportResponse,
} from './github';
import { GitHubTransportContractError } from './github';

export const REDIRECT_CONTRACT_BLOCKER =
	'Obsidian requestUrl redirect feasibility is not verified';

export type ObsidianGitHubTransportOptions = {
	/** True only after the bounded redirect feasibility check passes. */
	readonly redirectContractVerified?: boolean;
};

/**
 * Production-only Obsidian boundary. The provider adapter remains pure and
 * testable by receiving this transport as an injected dependency. The
 * redirect verification remains a post-merge production-enablement gate because
 * the supported response type does not expose final URL/origin information.
 */
export function createObsidianGitHubTransport(
	options: ObsidianGitHubTransportOptions = {},
): GitHubTransport {
	return async (
		request: GitHubTransportRequest,
	): Promise<GitHubTransportResponse> => {
		if (options.redirectContractVerified !== true)
			throw new GitHubTransportContractError(REDIRECT_CONTRACT_BLOCKER);
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
