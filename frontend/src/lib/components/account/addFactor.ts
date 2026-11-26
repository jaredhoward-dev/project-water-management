// Adding a way to get codes on the Account page (TwoStepSignIn.svelte; issue
// #882, docs/security.md § Two-step sign-in). A second way beside one that is
// on needs a session that gave a code (the API answers `403 mfa_step_up`
// otherwise, backend auth/mfa-routes.ts requireCodeForAnotherFactor): the
// panel then says so and offers to sign in again, instead of asking for the
// password it would refuse anyway. Pure, no words.
import { ApiError } from '#lib/api/client.js';
import type { MfaMethod, MfaStatus } from '#lib/api/types.js';

/** Whether adding `method` needs a sign-in with a code first: another way is on and this session gave only the password. */
export function needsStepUpToAdd(status: Pick<MfaStatus, 'methods' | 'sessionVerified'> | null, method: MfaMethod): boolean {
	if (!status) return false;
	return status.methods.length > 0 && !status.methods.includes(method) && !status.sessionVerified;
}

/** What a refused step of turning a way on means: sign in again with a code, a wrong password (the enrol's other 403), or anything else. */
export function setupRefusal(err: unknown): 'step-up' | 'wrong-password' | 'other' {
	if (!(err instanceof ApiError) || err.status !== 403) return 'other';
	return err.code === 'mfa_step_up' ? 'step-up' : 'wrong-password';
}
