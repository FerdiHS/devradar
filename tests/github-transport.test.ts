import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubTransportContractError } from '../src/adapters/github';

const obsidianPlatform = vi.hoisted(() => ({ isMobile: false }));
const requestUrl = vi.hoisted(() => vi.fn());

vi.mock('obsidian', () => ({ Platform: obsidianPlatform, requestUrl }));

describe('Obsidian GitHub transport boundary', () => {
	beforeEach(() => {
		requestUrl.mockReset();
		obsidianPlatform.isMobile = false;
	});

	it('uses requestUrl for the approved GitHub endpoint by default', async () => {
		requestUrl.mockResolvedValue({
			status: 200,
			headers: {},
			text: '{"ok":true}',
		});
		const { createObsidianGitHubTransport } =
			await import('../src/adapters/github-transport');
		const transport = createObsidianGitHubTransport();

		await expect(
			transport({
				url: 'https://api.github.com/users/octocat',
				headers: {},
			}),
		).resolves.toEqual({
			status: 200,
			headers: {},
			json: { ok: true },
		});
		expect(requestUrl).toHaveBeenCalledOnce();
	});

	it.each([
		['other origin', 'https://example.com/users/octocat'],
		['plain HTTP', 'http://api.github.com/users/octocat'],
		['credentials', 'https://user:pass@api.github.com/users/octocat'],
		[
			'unsupported path',
			'https://api.github.com/repos/octocat/hello-world',
		],
		[
			'fragment',
			'https://api.github.com/users/octocat/events/public?per_page=100#page',
		],
		[
			'malformed query',
			'https://api.github.com/users/octocat/events/public?page=1&per_page=99',
		],
		[
			'trailing query separator',
			'https://api.github.com/users/octocat/events/public?page=2&per_page=100&',
		],
	] as const)('rejects %s before requestUrl', async (_case, url) => {
		const { createObsidianGitHubTransport } =
			await import('../src/adapters/github-transport');
		const transport = createObsidianGitHubTransport();

		await expect(transport({ url, headers: {} })).rejects.toThrow(
			GitHubTransportContractError,
		);
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it('rejects unapproved headers before requestUrl', async () => {
		const { createObsidianGitHubTransport } =
			await import('../src/adapters/github-transport');
		const transport = createObsidianGitHubTransport();

		await expect(
			transport({
				url: 'https://api.github.com/users/octocat',
				headers: { 'X-Probe-Token': 'secret' },
			}),
		).rejects.toThrow(GitHubTransportContractError);
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it.each([
		'https://api.github.com/users/octocat/events/public?per_page=100',
		'https://api.github.com/users/octocat/events/public?page=2&per_page=100',
		'https://api.github.com/users/octocat/events/public?per_page=100&page=2',
	])('accepts approved Events URL %s', async (url) => {
		requestUrl.mockResolvedValue({
			status: 200,
			headers: {},
			text: '{}',
		});
		const { createObsidianGitHubTransport } =
			await import('../src/adapters/github-transport');
		const transport = createObsidianGitHubTransport();

		await expect(transport({ url, headers: {} })).resolves.toMatchObject({
			status: 200,
			json: {},
		});
		expect(requestUrl).toHaveBeenCalledOnce();
	});

	it('fails closed on Mobile before requestUrl', async () => {
		obsidianPlatform.isMobile = true;
		const { createObsidianGitHubTransport } =
			await import('../src/adapters/github-transport');
		const transport = createObsidianGitHubTransport();

		await expect(
			transport({
				url: 'https://api.github.com/users/octocat',
				headers: {},
			}),
		).rejects.toThrow(GitHubTransportContractError);
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it.each([302, 400, 500])(
		'preserves requestUrl status %i',
		async (status) => {
			requestUrl.mockResolvedValue({
				status,
				headers: {},
				text: '{}',
			});
			const { createObsidianGitHubTransport } =
				await import('../src/adapters/github-transport');
			const transport = createObsidianGitHubTransport();

			await expect(
				transport({
					url: 'https://api.github.com/users/octocat',
					headers: {},
				}),
			).resolves.toMatchObject({ status, json: {} });
		},
	);

	it('propagates requestUrl transport failures', async () => {
		const error = new Error('network unavailable');
		requestUrl.mockRejectedValue(error);
		const { createObsidianGitHubTransport } =
			await import('../src/adapters/github-transport');
		const transport = createObsidianGitHubTransport();

		await expect(
			transport({
				url: 'https://api.github.com/users/octocat',
				headers: {},
			}),
		).rejects.toBe(error);
	});

	it('passes the request contract to requestUrl', async () => {
		requestUrl.mockResolvedValue({
			status: 200,
			headers: { 'x-test': 'yes' },
			json: { ok: true },
			text: '{"ok":true}',
		});
		const { createObsidianGitHubTransport } =
			await import('../src/adapters/github-transport');
		const transport = createObsidianGitHubTransport();
		const result = await transport({
			url: 'https://api.github.com/users/octocat',
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent':
					'DevRadar/0.2.0-test (https://github.com/FerdiHS/devradar)',
				'X-GitHub-Api-Version': '2026-03-10',
			},
		});

		expect(result).toEqual({
			status: 200,
			headers: { 'x-test': 'yes' },
			json: { ok: true },
		});
		expect(requestUrl).toHaveBeenCalledWith({
			url: 'https://api.github.com/users/octocat',
			method: 'GET',
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent':
					'DevRadar/0.2.0-test (https://github.com/FerdiHS/devradar)',
				'X-GitHub-Api-Version': '2026-03-10',
			},
			throw: false,
		});
	});

	it('contains invalid JSON without reading requestUrl response.json', async () => {
		const response = {
			status: 200,
			headers: {},
			text: 'not-json',
		};
		Object.defineProperty(response, 'json', {
			get: () => {
				throw new Error('requestUrl JSON getter should not be used');
			},
		});
		requestUrl.mockResolvedValue(response);
		const { createObsidianGitHubTransport } =
			await import('../src/adapters/github-transport');
		const transport = createObsidianGitHubTransport();

		await expect(
			transport({
				url: 'https://api.github.com/users/octocat',
				headers: {},
			}),
		).resolves.toMatchObject({
			status: 200,
			json: undefined,
		});
	});
});
