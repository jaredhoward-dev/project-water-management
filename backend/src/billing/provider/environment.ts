// This deployment's billing tag (BILLING_ENVIRONMENT): checkout stamps it, the orphan check
// compares it (issue #641; docs/billing.md § Deleting an account). Its own module so the mock
// and Stripe clients can read it without importing provider.ts.

/** What BILLING_ENVIRONMENT may be: a short tag such as a hostname (Stripe keeps metadata values up to 500 characters). */
export const BILLING_ENVIRONMENT_SHAPE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/;
/** The tag this deployment stamps on what it sells when nothing names one: local dev and tests, with no setup. */
export const LOCAL_BILLING_ENVIRONMENT = 'local';

/**
 * This deployment's tag (BILLING_ENVIRONMENT; `local` when unset or not tag-shaped). Checkout stamps it
 * into the session's and the subscription's metadata (wm_environment), and the webhook cancels and
 * refunds an orphan only when the event carries this same tag, so two deployments on one Stripe
 * account never take each other's subscriptions for orphans (docs/billing.md § Deleting an account).
 * Production sets it from Terraform (the site's domain); config/production.ts refuses `local` there.
 */
export function billingEnvironment(env: NodeJS.ProcessEnv = process.env): string {
	const v = env.BILLING_ENVIRONMENT?.trim() ?? '';
	return BILLING_ENVIRONMENT_SHAPE.test(v) ? v : LOCAL_BILLING_ENVIRONMENT;
}
