// Free's verified-email gate (issue #641 § Free tier and abuse; docs/billing.md
// § Verified email on Free): with billing enforced, on a Free project an
// unverified person can't use the assistant or switch a data feed on (403
// email_unverified), nor someone with a temporary-mail address (403
// email_disposable). The workspace words it as #641's copy does: plain, no
// error colour, never "quota", "abuse" or "402". Workspace only (English).
import { ApiError } from '#lib/api/client.js';

export type EmailGateCode = 'email_unverified' | 'email_disposable';
export type EmailGateFeature = 'assistant' | 'feeds';

/** The gate's code when an error is its refusal, else null. */
export function emailGateCode(err: unknown): EmailGateCode | null {
	if (!(err instanceof ApiError) || err.status !== 403) return null;
	return err.code === 'email_unverified' || err.code === 'email_disposable' ? err.code : null;
}

const WHAT: Record<EmailGateFeature, string> = { assistant: 'use the assistant', feeds: 'switch on a live data feed' };

/** What the refusal says (#641's copy for the assistant; the feeds' the same shape). `email`: the signed-in person's own. */
export function emailGateText(code: EmailGateCode, feature: EmailGateFeature, email: string | null): string {
	if (code === 'email_unverified') return `Verify your email to ${WHAT[feature]}. We sent a link to ${email ?? 'your address'}.`;
	return `To ${WHAT[feature]} on the Free plan, you need a permanent email address. This one is from a temporary-mail service.`;
}
