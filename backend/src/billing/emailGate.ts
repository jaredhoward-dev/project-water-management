// Free's verified-email gate (issue #641 § Free tier and abuse: "the assistant
// and live feeds need a verified email"; docs/billing.md § Verified email on
// Free). With BILLING_ENFORCED on, a person on a project whose account is on
// Free (no live subscription) can't start an assistant turn or switch a data
// feed on until their email is verified, nor with an address on a disposable
// domain (auth/disposable.ts). Off, or on a paid or trialing account, nothing
// changes. Which projects are on Free, and the caller's own address, come from
// app_free_email_gate (343), as the caller.
import { isDisposable } from '../auth/disposable.js';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

/** What the gate refuses: the assistant or switching a feed on. */
export type GatedFeature = 'assistant' | 'feeds';

const WHAT: Record<GatedFeature, string> = { assistant: 'use the assistant', feeds: 'switch on a live data feed' };

/**
 * Refuses (403 email_unverified or email_disposable) when the gate applies to
 * the caller on this project; else returns. Call inside the route's withUser,
 * after its role check. The words are the workspace's (English, #641's copy:
 * no "quota", "abuse" or "402"); the panels word the refusal from its code.
 */
export async function requireFreeVerifiedEmail(db: Db, projectId: string, feature: GatedFeature): Promise<void> {
	const { rows } = await db.query<{ g: { email: string; verified: boolean } | null }>('SELECT app_free_email_gate($1) AS g', [projectId]);
	const gate = rows[0]?.g;
	if (!gate) return;
	if (!gate.verified) {
		// No address in the error (it reaches logs and caches); the panel shows the signed-in person's own.
		throw ApiError.coded(403, 'email_unverified', `Verify your email to ${WHAT[feature]}. We sent you a link.`);
	}
	if (isDisposable(gate.email)) {
		throw ApiError.coded(
			403,
			'email_disposable',
			`To ${WHAT[feature]} on the Free plan, you need a permanent email address. This one is from a temporary-mail service.`
		);
	}
}
