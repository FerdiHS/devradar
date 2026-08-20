import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestUrl = vi.fn();

vi.mock('obsidian', () => ({ requestUrl }));

describe('Obsidian GitHub transport boundary', () => {
	beforeEach(() => requestUrl.mockReset());

	it('fails closed until redirect feasibility is explicitly verified', async () => {
		const { createObsidianGitHubTransport, REDIRECT_CONTRACT_BLOCKER } =
			await import('../src/adapters/github-transport');
		const transport = createObsidianGitHubTransport();

		await expect(
			transport({
				url: 'https://api.github.com/users/octocat',
				headers: {},
			}),
		).rejects.toThrow(REDIRECT_CONTRACT_BLOCKER);
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it('uses requestUrl only after the explicit feasibility gate', async () => {
		requestUrl.mockResolvedValue({
			status: 200,
			headers: { 'x-test': 'yes' },
			json: { ok: true },
			text: '{"ok":true}',
		});
		const { createObsidianGitHubTransport } =
			await import('../src/adapters/github-transport');
		const transport = createObsidianGitHubTransport({
			redirectContractVerified: true,
		});
		const result = await transport({
			url: 'https://api.github.com/users/octocat',
			headers: { Accept: 'application/vnd.github+json' },
		});

		expect(result).toEqual({
			status: 200,
			headers: { 'x-test': 'yes' },
			json: { ok: true },
		});
		expect(requestUrl).toHaveBeenCalledWith({
			url: 'https://api.github.com/users/octocat',
			method: 'GET',
			headers: { Accept: 'application/vnd.github+json' },
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
		const transport = createObsidianGitHubTransport({
			redirectContractVerified: true,
		});

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
