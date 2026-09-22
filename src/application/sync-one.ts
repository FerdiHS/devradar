import type { ApplicationMutationGuard } from './mutation-guard';
import {
	SyncPersonExecutor,
	type SyncOneResult,
	type SyncOneSelection,
	type SyncPersonDependencies,
} from './sync-person';

export type {
	SyncOneFailureReason,
	SyncOneProviderResult,
	SyncOneResult,
	SyncOneSelection,
} from './sync-person';

export type SyncOneDependencies = SyncPersonDependencies & {
	readonly mutationGuard: ApplicationMutationGuard;
};

export class SyncOneApplication {
	private readonly personExecutor: SyncPersonExecutor;

	constructor(
		private readonly dependencies: SyncOneDependencies,
		personExecutor?: SyncPersonExecutor,
	) {
		this.personExecutor =
			personExecutor ?? new SyncPersonExecutor(dependencies);
	}

	async syncOne(selection: SyncOneSelection): Promise<SyncOneResult> {
		try {
			const execution = await this.dependencies.mutationGuard.run(() =>
				this.personExecutor.execute(selection),
			);
			return execution.result;
		} catch {
			return { kind: 'failed', reason: 'internal' };
		}
	}
}
