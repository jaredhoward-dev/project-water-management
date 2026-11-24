// The 14-day Pro reverse trial (issue #641 "Reverse trial: yes, 14 days";
// 342_reverse_trial.sql, docs/billing.md § Pro: the reverse trial). Built but
// off: asked for only with REVERSE_TRIAL=true and BILLING_ENFORCED=true.
import { createHash } from 'node:crypto';
import type { Db } from '../db/tx.js';
import { isDisposable } from '../auth/disposable.js';
import { billingEnforced } from './enforced.js';
import { canonicalEmail } from './metrics.js';

/**
 * Whether a newly verified person gets the reverse trial: only the exact string
 * `true` in REVERSE_TRIAL, and only with BILLING_ENFORCED on (a Pro trial means
 * nothing while no plan limit refuses anything, and granting one then would
 * spend the person's once-per-email trial for nothing).
 */
export const reverseTrialOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.REVERSE_TRIAL === 'true' && billingEnforced(env);

/** What reverse_trial_claim keeps for an address: SHA-256 (hex) of its canonical form, never the address. */
export const reverseTrialHash = (email: string): string => createHash('sha256').update(canonicalEmail(email)).digest('hex');

export type ReverseTrialOutcome = 'started' | 'claimed' | 'live' | 'unverified' | 'disposable' | 'off';

/**
 * Start the caller's reverse trial on their own account (the transaction acts
 * as `userId`, db/tx.ts actAsUser). Called when an address is first verified
 * (auth/email-routes.ts markVerified); 'off' when the setting is off, and
 * 'disposable' for an address on a disposable domain (auth/disposable.ts, #641
 * item 5): no trial and nothing claimed, so a real address later still gets one.
 */
export async function startReverseTrial(db: Db, userId: string, env: NodeJS.ProcessEnv = process.env): Promise<ReverseTrialOutcome> {
	if (!reverseTrialOn(env)) return 'off';
	const { rows } = await db.query<{ email: string }>('SELECT email FROM app_user WHERE id = $1', [userId]);
	if (!rows[0]) return 'unverified';
	if (isDisposable(rows[0].email)) return 'disposable';
	const { rows: out } = await db.query<{ outcome: ReverseTrialOutcome }>('SELECT app_reverse_trial_start($1) AS outcome', [reverseTrialHash(rows[0].email)]);
	return out[0]!.outcome;
}
