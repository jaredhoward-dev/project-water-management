// The billing provider seam (issue #641 Phase 3, docs/billing.md § Webhooks and
// providers). BILLING_PROVIDER picks one of three:
//
//   mock   (the code default, local-first) — Stripe-shaped events signed with the
//          committed dev-only key (backend/.env.development BILLING_WEBHOOK_SECRET),
//          so the whole webhook path runs with no Stripe account. Production refuses
//          it (config/production.ts).
//   manual — subscriptions the operator records by hand (B2B invoices); accepts no webhooks.
//   stripe — Stripe's signed events, checked over the raw body with node:crypto
//          (provider/signature.ts) and normalised (provider/stripe.ts). No `stripe`
//          package this round.
//
// Any other value is no provider at all: every webhook is 404. It never falls back to
// the mock (feohledger's billing doc: a mistyped provider name that resolved to its
// mock turned the public route into an unsigned subscription writer).
//
// The secret is BILLING_WEBHOOK_SECRET, read from the environment only (production:
// the API's runtime secret, from infra-secrets; docs/deployment.md). Unset or empty,
// every signature fails.
import { SIGNATURE_HEADER, verifySignature } from './provider/signature.js';
import { normaliseStripeEvent } from './provider/stripe.js';

export const BILLING_PROVIDERS = ['mock', 'manual', 'stripe'] as const;
export type BillingProviderName = (typeof BILLING_PROVIDERS)[number];

export const PLAN_CODES = ['free', 'pro', 'team'] as const;
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired';

/** The payload app_billing_apply applies (326_billing_events.sql; the round 2 contract). */
export interface SubscriptionPayload {
	accountId: string;
	planCode: string;
	status: SubscriptionStatus;
	seats: number;
	periodStart: string;
	periodEnd: string;
	trialEnd: string | null;
	cancelAtPeriodEnd: boolean;
	externalRef: string;
	/** When the provider created the event (ISO): app_billing_apply skips an update older than the last one applied as `stale` (327); absent or null applies in arrival order. */
	eventCreated?: string | null;
}
/** What a recorded-only event carries: whose it is, and the subscription it names when it names one. */
export interface RecordPayload {
	accountId: string;
	externalRef: string | null;
	eventCreated?: string | null;
}
export type NormalisedEvent =
	| { eventId: string; type: 'subscription.updated' | 'subscription.deleted'; payload: SubscriptionPayload }
	| { eventId: string; type: 'checkout.completed' | 'invoice.paid' | 'invoice.payment_failed' | 'subscription.pending'; payload: RecordPayload };

export type VerifyResult =
	| { ok: true; event: NormalisedEvent }
	/** Signed, but a type we don't act on: answered 200, never written. */
	| { ok: true; ignored: { eventId: string; type: string } }
	| { ok: false; reason: 'signature' | 'invalid' };

export interface BillingProvider {
	name: BillingProviderName;
	/** Whether POST /billing/webhook/<name> exists at all (404 when not). */
	acceptsWebhooks: boolean;
	verifyAndNormalise(rawBody: string, headers: Record<string, string | undefined>, nowMs?: number): VerifyResult;
}

/** BILLING_PROVIDER as one of ours (unset is the mock, the code default), or null for a value that names none. */
export function billingProviderName(env: NodeJS.ProcessEnv = process.env): BillingProviderName | null {
	const v = env.BILLING_PROVIDER?.trim() || 'mock';
	return (BILLING_PROVIDERS as readonly string[]).includes(v) ? (v as BillingProviderName) : null;
}

/** Stripe's scheme: a signature check over the raw body, then the normaliser. The mock is the same with the dev key. */
function signedStripeShaped(name: 'mock' | 'stripe', secret: string | undefined): BillingProvider {
	return {
		name,
		acceptsWebhooks: true,
		verifyAndNormalise(rawBody, headers, nowMs = Date.now()) {
			if (!verifySignature(rawBody, headers[SIGNATURE_HEADER], secret, nowMs)) return { ok: false, reason: 'signature' };
			let body: unknown;
			try {
				body = JSON.parse(rawBody);
			} catch {
				return { ok: false, reason: 'invalid' };
			}
			const r = normaliseStripeEvent(body);
			if (r.kind === 'invalid') return { ok: false, reason: 'invalid' };
			if (r.kind === 'ignored') return { ok: true, ignored: { eventId: r.eventId, type: r.type } };
			return { ok: true, event: r.event };
		}
	};
}

const manual: BillingProvider = {
	name: 'manual',
	acceptsWebhooks: false,
	verifyAndNormalise: () => ({ ok: false, reason: 'signature' })
};

/** The configured provider, or null when BILLING_PROVIDER names none. Read per request, so a test can set the env. */
export function billingProvider(env: NodeJS.ProcessEnv = process.env): BillingProvider | null {
	const name = billingProviderName(env);
	if (name === null) return null;
	if (name === 'manual') return manual;
	return signedStripeShaped(name, env.BILLING_WEBHOOK_SECRET?.trim() || undefined);
}
