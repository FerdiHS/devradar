import { describe, expect, it } from 'vitest';
import { createApplicationMutationGuard } from '../src/application/mutation-guard';

describe('application mutation guard', () => {
	it('does not run overlapping operations concurrently', async () => {
		const guard = createApplicationMutationGuard();
		const events: string[] = [];
		let release!: () => void;
		const firstBlocked = new Promise<void>((resolve) => {
			release = resolve;
		});

		const first = guard.run(async () => {
			events.push('first-start');
			await firstBlocked;
			events.push('first-end');
			return 'first';
		});
		const second = guard.run(async () => {
			events.push('second-start');
			return 'second';
		});

		await Promise.resolve();
		expect(events).toEqual(['first-start']);
		release();

		expect(await Promise.all([first, second])).toEqual(['first', 'second']);
		expect(events).toEqual(['first-start', 'first-end', 'second-start']);
	});

	it('releases the guard after rejection', async () => {
		const guard = createApplicationMutationGuard();
		const first = guard.run(async () => {
			throw new Error('expected');
		});
		const second = guard.run(async () => 'next');

		await expect(first).rejects.toThrow('expected');
		expect(await second).toBe('next');
	});
});
