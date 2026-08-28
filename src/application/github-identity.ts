import type { GitHubRequestPolicyV1 } from '../domain/settings';

export type GitHubIdentity = {
	readonly username: string;
	readonly githubAccountId: string;
};

export type GitHubIdentityRequest = {
	readonly username: string;
	readonly globalPolicy?: GitHubRequestPolicyV1;
};

export type GitHubPolicyObservation = {
	readonly rateLimitNotBefore?: string;
	readonly pollNotBefore?: string;
};

export type GitHubIdentityResult =
	| {
			readonly kind: 'success';
			readonly requestAttempted: true;
			readonly data: GitHubIdentity;
			readonly policy: GitHubPolicyObservation;
	  }
	| {
			readonly kind: 'no-request';
			readonly requestAttempted: false;
			readonly notBefore?: string;
			readonly policy: GitHubPolicyObservation;
	  }
	| {
			readonly kind: 'person-failure';
			readonly requestAttempted: boolean;
			readonly policy: GitHubPolicyObservation;
	  }
	| {
			readonly kind: 'provider-failure';
			readonly requestAttempted: boolean;
			readonly policy: GitHubPolicyObservation;
	  };
