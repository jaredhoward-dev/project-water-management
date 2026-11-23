// The billing provider seam (issue #641 Phase 3, docs/billing.md § Webhooks and
// providers). BILLING_PROVIDER picks one of three:
//
//   mock   (the code default, local-first) — Stripe-shaped events signed with the
//          committed dev-only key (backend/.env.development BILLING_WEBHOOK_SECRET),
//          so the whole webhook path runs with no Stripe account. Production refuses
//          it (config/production.ts).
//   manual — subscriptions the operator records by hand (B2B invoices); accepts no webhooks.
//   stripe — Stripe's signed events, checked over the raw body with node:crypto
//          (provider/signature.ts) and normalised (provider/stripe.ts); checkout and
//          the portal call Stripe's API over fetch (provider/stripeApi.ts), no
//          `stripe` package (docs/billing.md § Checkout and portal, the research).
//
// Checkout and the portal (createCheckout, createPortal) answer a URL to send
// the person to: Stripe's hosted pages, the mock's local pages
// (billing/mockCheckout.ts), or, for manual, a coded refusal.
//
// Any other value is no provider at all: every webhook is 404. It never falls back to
// the mock (feohledger's billing doc: a mistyped provider name that resolved to its
// mock turned the public route into an unsigned subscription writer).
//
// The secret is BILLING_WEBHOOK_SECRET, read from the environment only (production:
// the API's runtime secret, from infra-secrets; docs/deployment.md). Unset or empty,
// every signature fails.
import { ApiError } from '../http/errors.js';
import { MOCK_SESSION_TTL_SECONDS, signMockSession } from './provider/mock.js';
import { SIGNATURE_HEADER, verifySignature } from './provider/signature.js';
import { normaliseStripeEvent } from './provider/stripe.js';
import { createCheckoutSession, createCustomer, createPortalSession, StripeApiError } from './provider/stripeApi.js';

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
	/** When the provider created the event (ISO), for ordering later; app_billing_apply ignores it for now. */
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

export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** The account checkout or the portal is for: its id and the provider's customer, when 328 holds one. */
export interface CheckoutAccount {
	id: string;
	customerRef: string | null;
}
/** The plan bought, as app_billing_plans has it (prices in minor units). */
export interface CheckoutPlan {
	code: string;
	name: string;
	priceMonthlyMinor: number;
	priceAnnualMinor: number;
	currency: string;
}
/** The account's live subscription as app_account_plan answers it, for the mock portal. */
export interface LiveSubscription {
	planCode: string;
	status: string;
	periodStart: string | null;
	periodEnd: string | null;
	cancelAtPeriodEnd: boolean;
	seats: number;
}
export interface ReturnUrls {
	/** Where the provider sends the person back to: the plan page, with `?checkout=done` or `?checkout=cancelled` for checkout. */
	successUrl: string;
	cancelUrl: string;
	/** This API's own origin and prefix, where the mock's pages live (never used by stripe). */
	apiBase: string;
}
/** A URL to send the person to, and the customer the provider made for the account when it made one (the route stores it, 328). */
export interface CheckoutResult {
	url: string;
	newCustomerRef?: string;
}

/** The provider takes no checkout (manual, or none configured): the plan page hides its buttons, so this is a stale page or a hand-made call. */
export class BillingUnavailableError extends ApiError {
	constructor() {
		super(409, 'online billing isn’t available here; ask the operator to change your plan');
		this.code = 'billing_unavailable';
	}
}
/** The provider failed or isn't set up (stripe with no key): a 503, never the provider's own text (rule 6). */
export class BillingProviderError extends ApiError {
	constructor() {
		super(503, 'the payment provider couldn’t be reached; try again in a minute');
		this.code = 'billing_provider_error';
	}
}
/** The portal opens for a customer, and the account has none yet: it never checked out. */
export class BillingNoCustomerError extends ApiError {
	constructor() {
		super(409, 'there is no billing to manage yet: this account has never subscribed');
		this.code = 'billing_no_customer';
	}
}

export interface BillingProvider {
	name: BillingProviderName;
	/** Whether POST /billing/webhook/<name> exists at all (404 when not). */
	acceptsWebhooks: boolean;
	verifyAndNormalise(rawBody: string, headers: Record<string, string | undefined>, nowMs?: number): VerifyResult;
	/** Where to send the person to buy `plan` at `interval` for `account`. */
	createCheckout(account: CheckoutAccount, plan: CheckoutPlan, interval: BillingInterval, urls: ReturnUrls): Promise<CheckoutResult>;
	/** Where to send the person to manage the account's billing (card, invoices, cancel). */
	createPortal(account: CheckoutAccount, subscription: LiveSubscription | null, urls: ReturnUrls): Promise<CheckoutResult>;
}

/** BILLING_PROVIDER as one of ours (unset is the mock, the code default), or null for a value that names none. */
export function billingProviderName(env: NodeJS.ProcessEnv = process.env): BillingProviderName | null {
	const v = env.BILLING_PROVIDER?.trim() || 'mock';
	return (BILLING_PROVIDERS as readonly string[]).includes(v) ? (v as BillingProviderName) : null;
}

/** Stripe's webhook scheme: a signature check over the raw body, then the normaliser. The mock is the same with the dev key. */
function verifier(secret: string | undefined): BillingProvider['verifyAndNormalise'] {
	return (rawBody, headers, nowMs = Date.now()) => {
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
	};
}

const priceFor = (plan: CheckoutPlan, interval: BillingInterval) => (interval === 'year' ? plan.priceAnnualMinor : plan.priceMonthlyMinor);
const exp = (nowMs: number) => Math.floor(nowMs / 1000) + MOCK_SESSION_TTL_SECONDS;

/**
 * The mock: checkout and the portal are local pages on this API (billing/mockCheckout.ts),
 * reached through a token signed with the dev key. Nothing leaves the machine.
 */
function mockProvider(secret: string | undefined, now: () => number): BillingProvider {
	const sign = (session: Parameters<typeof signMockSession>[1]) => {
		if (!secret) throw new BillingProviderError();
		return signMockSession(secret, session);
	};
	return {
		name: 'mock',
		acceptsWebhooks: true,
		verifyAndNormalise: verifier(secret),
		async createCheckout(account, plan, interval, urls) {
			const t = sign({
				kind: 'checkout',
				accountId: account.id,
				planCode: plan.code,
				planName: plan.name,
				amountMinor: priceFor(plan, interval),
				currency: plan.currency,
				interval,
				successUrl: urls.successUrl,
				cancelUrl: urls.cancelUrl,
				exp: exp(now())
			});
			return { url: `${urls.apiBase}/billing/mock/checkout?t=${encodeURIComponent(t)}` };
		},
		async createPortal(account, subscription, urls) {
			const live =
				subscription && subscription.periodStart && subscription.periodEnd
					? { ...subscription, periodStart: subscription.periodStart, periodEnd: subscription.periodEnd }
					: null;
			const t = sign({ kind: 'portal', accountId: account.id, returnUrl: urls.successUrl, subscription: live, exp: exp(now()) });
			return { url: `${urls.apiBase}/billing/mock/portal?t=${encodeURIComponent(t)}` };
		}
	};
}

/** Stripe: webhooks checked with the endpoint's secret, checkout and the portal through its API with STRIPE_SECRET_KEY. */
function stripeProvider(webhookSecret: string | undefined, secretKey: string | undefined, fetchImpl?: typeof fetch): BillingProvider {
	const client = () => {
		if (!secretKey) throw new BillingProviderError();
		return { secretKey, fetch: fetchImpl };
	};
	const call = async <T>(f: () => Promise<T>): Promise<T> => {
		try {
			return await f();
		} catch (e) {
			if (e instanceof StripeApiError || (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError' || e.name === 'TypeError'))) {
				throw Object.assign(new BillingProviderError(), { cause: e });
			}
			throw e;
		}
	};
	return {
		name: 'stripe',
		acceptsWebhooks: true,
		verifyAndNormalise: verifier(webhookSecret),
		async createCheckout(account, plan, interval, urls) {
			const o = client();
			return call(async () => {
				const made = account.customerRef ? undefined : await createCustomer(o, account.id);
				const url = await createCheckoutSession(o, {
					customer: account.customerRef ?? made!,
					accountId: account.id,
					planCode: plan.code,
					planName: plan.name,
					currency: plan.currency,
					unitAmountMinor: priceFor(plan, interval),
					interval,
					successUrl: urls.successUrl,
					cancelUrl: urls.cancelUrl
				});
				return made ? { url, newCustomerRef: made } : { url };
			});
		},
		async createPortal(account, _subscription, urls) {
			if (!account.customerRef) throw new BillingNoCustomerError();
			const o = client();
			return call(async () => ({ url: await createPortalSession(o, account.customerRef!, urls.successUrl) }));
		}
	};
}

const manual: BillingProvider = {
	name: 'manual',
	acceptsWebhooks: false,
	verifyAndNormalise: () => ({ ok: false, reason: 'signature' }),
	createCheckout: async () => {
		throw new BillingUnavailableError();
	},
	createPortal: async () => {
		throw new BillingUnavailableError();
	}
};

/** The configured provider, or null when BILLING_PROVIDER names none. Read per request, so a test can set the env. */
export function billingProvider(
	env: NodeJS.ProcessEnv = process.env,
	deps: { fetch?: typeof fetch; now?: () => number } = {}
): BillingProvider | null {
	const name = billingProviderName(env);
	if (name === null) return null;
	if (name === 'manual') return manual;
	const webhookSecret = env.BILLING_WEBHOOK_SECRET?.trim() || undefined;
	if (name === 'mock') return mockProvider(webhookSecret, deps.now ?? Date.now);
	return stripeProvider(webhookSecret, env.STRIPE_SECRET_KEY?.trim() || undefined, deps.fetch);
}
