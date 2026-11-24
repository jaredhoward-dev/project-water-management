// Free's verified-email gate (issue #641 § Free tier and abuse: "the assistant
// and live feeds need a verified email"; docs/billing.md § Verified email on
// Free). With BILLING_ENFORCED on, a person on a project whose account is on
// Free (no live subscription) can't start an assistant turn or switch a data
// feed on until their email is verified, nor with an address on a disposable
// domain (auth/disposable.ts). Off, or on a paid or trialing account, nothing
// changes. Which projects are on Free, and the caller's own address, come from
// app_free_email_gate (343), as the caller.
// Each refusal is logged (email_gate_refused: the code and feature, never the
// address or its domain) and counted per SAST day in email_gate_refusal (348)
// for the abuse report (billing/metrics.ts). The count is written after the
// route's transaction has ended (countGateRefusals), never inside it: the
// assistant Lambda's pool is one connection (infra/assistant.tf), so a second
// statement while the route still holds it would wait out the acquire timeout.
import { isDisposable } from '../auth/disposable.js';
import { queryWithoutUser, type Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';

/** What the gate refuses: the assistant or switching a feed on. */
export type GatedFeature = 'assistant' | 'feeds';

const WHAT: Record<GatedFeature, string> = { assistant: 'use the assistant', feeds: 'switch on a live data feed' };

export type GateRefusal = 'email_unverified' | 'email_disposable';

/** The gate's 403: an ApiError (so the error handler answers it as one) that says what was refused, for the count. */
export class EmailGateRefused extends ApiError {
	constructor(
		readonly refusal: GateRefusal,
		readonly feature: GatedFeature,
		message: string
	) {
		super(403, message);
		this.code = refusal;
	}
}

/**
 * Logs and counts one refusal: its own autocommit statement, as no user
 * (app_email_gate_refused, 348, takes no address). Call only with no pooled
 * connection held (countGateRefusals does). A failed count is logged and the
 * refusal still answers 403, never a 500.
 */
export async function recordGateRefusal(code: GateRefusal, feature: GatedFeature): Promise<void> {
	logEvent('info', { event: 'email_gate_refused', code, feature });
	try {
		await queryWithoutUser('SELECT app_email_gate_refused($1, $2)', [code, feature]);
	} catch (err) {
		logEvent('warn', { event: 'email_gate_count_failed', code, feature, ...safeError(err) });
	}
}

/**
 * Runs `fn` (the route's withUser call, whose callback calls
 * requireFreeVerifiedEmail) and, when the gate refused, counts the refusal
 * once that transaction has rolled back and its connection is back in the
 * pool, then rethrows the 403. Every route that calls the gate wraps its
 * withUser in this, so a refusal never needs a second connection.
 */
export async function countGateRefusals<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof EmailGateRefused) await recordGateRefusal(err.refusal, err.feature);
		throw err;
	}
}

/**
 * Refuses (403 email_unverified or email_disposable) when the gate applies to
 * the caller on this project; else returns. Call inside the route's withUser,
 * after its role check, with that withUser wrapped in countGateRefusals. The
 * words are the workspace's (English, #641's copy: no "quota", "abuse" or
 * "402"); the panels word the refusal from its code.
 */
export async function requireFreeVerifiedEmail(db: Db, projectId: string, feature: GatedFeature): Promise<void> {
	const { rows } = await db.query<{ g: { email: string; verified: boolean } | null }>('SELECT app_free_email_gate($1) AS g', [projectId]);
	const gate = rows[0]?.g;
	if (!gate) return;
	if (!gate.verified) {
		// No address in the error (it reaches logs and caches); the panel shows the signed-in person's own.
		throw new EmailGateRefused('email_unverified', feature, `Verify your email to ${WHAT[feature]}. We sent you a link.`);
	}
	if (isDisposable(gate.email)) {
		throw new EmailGateRefused(
			'email_disposable',
			feature,
			`To ${WHAT[feature]} on the Free plan, you need a permanent email address. This one is from a temporary-mail service.`
		);
	}
}
