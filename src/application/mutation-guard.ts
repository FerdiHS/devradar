export interface ApplicationMutationGuard {
	run<T>(operation: () => Promise<T>): Promise<T>;
}

export function createApplicationMutationGuard(): ApplicationMutationGuard {
	let tail = Promise.resolve();

	return {
		run: async <T>(operation: () => Promise<T>): Promise<T> => {
			const previous = tail;
			let release!: () => void;
			tail = new Promise<void>((resolve) => {
				release = resolve;
			});
			await previous;
			try {
				return await operation();
			} finally {
				release();
			}
		},
	};
}
