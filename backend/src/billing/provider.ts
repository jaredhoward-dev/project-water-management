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
import type { PublicPlan } from './entitlements.js';
import { SIGNATURE_HEADER, verifySignature } from './provider/signature.js';
import { normaliseStripeEvent } from './provider/stripe.js';
import { billingEnvironment } from './provider/environment.js';
export { BILLING_ENVIRONMENT_SHAPE, billingEnvironment, LOCAL_BILLING_ENVIRONMENT } from './provider/environment.js';
import { MOCK_SESSION_TTL_SECONDS, seatsChangedEvent, signMockSession } from './provider/mock.js';
import { createHash } from 'node:crypto';
import { cancelSubscription, changeSeatItem, createCheckoutSession, createCustomer, createInvoice as createStripeInvoice, createPortalSession, ensureExtraSeatProduct, expireCheckoutSession, getSubscriptionItems, listOpenCheckoutSessions, listOpenSubscriptions, orphanCancelAndRefund, StripeApiError, type InvoiceLine, type OrphanResult } from './provider/stripeApi.js';

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
	/** How often it bills (332): month or year, null when the provider's interval is neither (an interval_count past 1, or no price); absent from an older sender, which keeps the stored one. */
	interval?: BillingInterval | null;
	/** When the provider created the event (ISO): app_billing_apply skips an update older than the last one applied as `stale` (327); absent or null applies in arrival order. */
	eventCreated?: string | null;
	/** What it costs each interval (405, issue #928): checked against the plan table for a live status; absent from an older sender (not checked). */
	price?: SubscriptionPrice;
}
export interface SubscriptionPrice {
	/** The items' unit_amount × quantity, summed, in minor units; null when an item's price can't be read. */
	totalMinor: number | null;
	/** Lower-case ISO 4217; null with a null total. */
	currency: string | null;
	/** A coupon or discount is attached: never accepted as the plan. */
	discounted: boolean;
}
/** What a recorded-only event carries: whose it is, and the subscription it names when it names one. */
export interface RecordPayload {
	accountId: string;
	externalRef: string | null;
	eventCreated?: string | null;
	/** invoice.paid for a staff-tool B2B invoice (no subscription): the grant its metadata names (335). */
	invoice?: InvoiceGrantPayload;
}
/** A paid B2B invoice's grant, as the normaliser read it; null where a field didn't parse (app_billing_apply refuses it). */
export interface InvoiceGrantPayload {
	/** The provider's invoice id (in_…): the granted subscription's external_ref, so the same invoice grants once. */
	ref: string | null;
	planCode: string | null;
	seats: number | null;
	interval: string | null;
	/** ISO: the period paid for (start inclusive, end exclusive). */
	periodStart: string | null;
	periodEnd: string | null;
	/** The invoice's total and currency: the total must cover the amount issued (else the plan table's price); the grant never reads an amount. */
	totalMinor: number | null;
	/** The total the staff tool issued the invoice for (metadata amount_minor), or null when absent or unparsable. */
	issuedMinor: number | null;
	currency: string | null;
}
/**
 * `environment`: the deployment tag the object's metadata carries (wm_environment, stamped at checkout;
 * absent when it carries none). Never sent to app_billing_apply: only the webhook's orphan check reads it.
 */
export type NormalisedEvent =
	| { eventId: string; type: 'subscription.updated' | 'subscription.deleted'; payload: SubscriptionPayload; environment?: string }
	| { eventId: string; type: 'checkout.completed' | 'invoice.paid' | 'invoice.payment_failed' | 'subscription.pending'; payload: RecordPayload; environment?: string };

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
	/** Editor seats the base price includes (limits.seats_included; 1 when the plan says none). */
	seatsIncluded: number;
	/** The price of each seat past seatsIncluded (features.extra_seat_*_minor), or null when the plan sells no extra seats (Pro). */
	extraSeatMonthlyMinor: number | null;
	extraSeatAnnualMinor: number | null;
}

/** Which plan each kind of account can buy: Pro is a person's, Team a team's (docs/billing.md § Who the plan belongs to). */
export const PURCHASABLE: Record<'user' | 'team', string> = { user: 'pro', team: 'team' };

const minor = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** A public plan as checkout prices it: its included seats (limits.seats_included) and extra-seat prices (features.extra_seat_*_minor). */
export function checkoutPlanOf(p: PublicPlan): CheckoutPlan {
	const included = p.limits.seats_included;
	return {
		code: p.code,
		name: p.name,
		priceMonthlyMinor: p.priceMonthlyMinor,
		priceAnnualMinor: p.priceAnnualMinor,
		currency: p.currency,
		seatsIncluded: typeof included === 'number' && Number.isInteger(included) && included >= 1 ? included : 1,
		extraSeatMonthlyMinor: minor(p.features.extra_seat_monthly_minor),
		extraSeatAnnualMinor: minor(p.features.extra_seat_annual_minor)
	};
}

/** The most editor seats one checkout sells (Team; docs/billing.md § Team seats at checkout). Past it is Agency, a contract. */
export const MAX_CHECKOUT_SEATS = 50;

/** The checkout's prices: the base, and the extra seats past the included ones at their price (0 of them when none). */
export function checkoutPrices(plan: CheckoutPlan, interval: BillingInterval, seats: number): { baseMinor: number; extraSeats: number; extraSeatMinor: number; totalMinor: number } {
	const baseMinor = interval === 'year' ? plan.priceAnnualMinor : plan.priceMonthlyMinor;
	const extraSeatMinor = (interval === 'year' ? plan.extraSeatAnnualMinor : plan.extraSeatMonthlyMinor) ?? 0;
	const extraSeats = Math.max(0, seats - plan.seatsIncluded);
	return { baseMinor, extraSeats, extraSeatMinor, totalMinor: baseMinor + extraSeats * extraSeatMinor };
}
/** The account's live subscription as app_account_plan answers it, for the mock portal. */
export interface LiveSubscription {
	planCode: string;
	/** The plan's name ("Pro"), for the mock's portal page to show. */
	planName?: string;
	status: string;
	periodStart: string | null;
	periodEnd: string | null;
	cancelAtPeriodEnd: boolean;
	seats: number;
	/** The plan's included seats, so the mock's portal event carries the subscription's items as checkout made them. */
	seatsIncluded?: number;
	/** How often it bills (332), so the mock's portal event carries it as Stripe would; null when not recorded. */
	interval?: BillingInterval | null;
	/** Which provider holds it and under which id (333): the mock's portal cancels its own by that id, and shows a `manual` one's invoices only. */
	provider?: string;
	externalRef?: string | null;
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

/** A Team's seat change (POST /teams/:id/plan/seats): the live subscription, where the provider holds it, and the seats wanted. */
export interface SeatChange {
	accountId: string;
	/** The provider's subscription id (Stripe's sub_…; the mock's sub_mock_…), from 333. */
	externalRef: string;
	plan: CheckoutPlan;
	subscription: LiveSubscription & { periodStart: string; periodEnd: string };
	/** Editor seats in all after the change (the route checked the range). */
	seats: number;
}

/** A grant (provider 'manual') holds the subscription: its seats change by a new grant, never here. */
export class BillingGrantSeatsError extends ApiError {
	constructor() {
		super(409, 'this plan was granted by the operator; ask them to change its seats with a new grant');
		this.code = 'billing_grant_seats';
	}
}

/** A B2B invoice the operator issues from the staff tool (billing/invoice.ts; docs/billing.md § B2B invoices). */
export interface InvoiceRequest {
	account: CheckoutAccount;
	planCode: string;
	seats: number;
	interval: BillingInterval;
	currency: string;
	poNumber: string;
	/** Unix seconds: the period paid for (start inclusive, end exclusive). */
	periodStart: number;
	periodEnd: number;
	lines: InvoiceLine[];
	/** Our key for this invoice (billing/invoice.ts invoiceKey): the same request gives the same key, so a retry never invoices twice. */
	key: string;
}
export interface InvoiceResult {
	invoiceId: string;
	number: string | null;
	status: string;
	totalMinor: number;
	/** ISO, or null when the provider gave none. */
	dueAt: string | null;
	reused: boolean;
	/** The customer the provider made for the account when it had none (the caller stores it, 328). */
	newCustomerRef?: string;
}

/** A person's account about to be deleted (auth/deleteAccount.ts): its customer at the provider and its live subscriptions there. */
export interface CancelRequest {
	accountId: string;
	/** The provider's customer (328), or null when the account never checked out with it. */
	customerRef: string | null;
	/** The external refs of the account's live subscriptions this provider holds, as our database has them. */
	subscriptionRefs: string[];
}

export interface BillingProvider {
	name: BillingProviderName;
	/** Whether POST /billing/webhook/<name> exists at all (404 when not). */
	acceptsWebhooks: boolean;
	verifyAndNormalise(rawBody: string, headers: Record<string, string | undefined>, nowMs?: number): VerifyResult;
	/** Where to send the person to buy `plan` at `interval` for `account`, with `seats` editor seats in all (the route checked them; default the plan's included seats). */
	createCheckout(account: CheckoutAccount, plan: CheckoutPlan, interval: BillingInterval, urls: ReturnUrls, seats?: number): Promise<CheckoutResult>;
	/** Where to send the person to manage the account's billing (card, invoices, cancel). */
	createPortal(account: CheckoutAccount, subscription: LiveSubscription | null, urls: ReturnUrls): Promise<CheckoutResult>;
	/**
	 * Change a Team's editor seats on its live subscription. Writes no seats itself: the
	 * provider's customer.subscription.updated brings them back through the webhook
	 * (app_billing_apply), as checkout's do.
	 */
	changeSeats(change: SeatChange): Promise<void>;
	/** Issue a B2B invoice (net 30, the PO number on it) and send it to the customer, once per key. */
	createInvoice(req: InvoiceRequest): Promise<InvoiceResult>;
	/**
	 * Cancel, now and with no refund, every subscription of the account that can still
	 * charge: the ones named and, where the provider can list them, any other its customer
	 * has. Answers the refs cancelled. Throws when any can't be, so the caller deletes
	 * nothing (docs/billing.md § Deleting an account).
	 */
	cancelSubscriptions(req: CancelRequest): Promise<string[]>;
	/**
	 * A live subscription whose account can't be found (a checkout paid after the account was
	 * deleted; billing/webhook.ts): cancel it now and refund its first invoice when that was paid
	 * within the refund window (stripeApi.ts ORPHAN_REFUND_WINDOW_SECONDS), safe to repeat (a
	 * redelivered event refunds once); an ended one with an older first invoice is `skipped`.
	 * Throws when a step fails, so the webhook answers non-2xx and the provider retries
	 * (docs/billing.md § Deleting an account).
	 */
	cancelOrphan(req: OrphanRequest): Promise<OrphanResult>;
}

/** The orphaned subscription: the account id its metadata names (gone) and the provider's ref. */
export interface OrphanRequest {
	accountId: string;
	subscriptionRef: string;
}
export type { OrphanResult };

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
		async createCheckout(account, plan, interval, urls, seats = plan.seatsIncluded) {
			const prices = checkoutPrices(plan, interval, seats);
			const t = sign({
				kind: 'checkout',
				accountId: account.id,
				planCode: plan.code,
				planName: plan.name,
				amountMinor: prices.totalMinor,
				currency: plan.currency,
				seats: Math.max(seats, plan.seatsIncluded),
				seatsIncluded: plan.seatsIncluded,
				extraSeatMinor: prices.extraSeatMinor,
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
		},
		// Stripe's answer to a quantity change, at once: the signed customer.subscription.updated with the
		// new extra-seat item, posted to the real webhook route (billing/mockCheckout.ts), so app_billing_apply writes the seats.
		async changeSeats(change) {
			if (!secret) throw new BillingProviderError();
			const { deliverMockEvent } = await import('./mockCheckout.js');
			const event = seatsChangedEvent(change.accountId, change.externalRef, change.subscription, change.plan.seatsIncluded, change.seats, now());
			if (!(await deliverMockEvent(event)).taken) throw new BillingProviderError();
		},
		// No network: an invoice id from the key, so the same request answers the same invoice (as Stripe's would).
		async createInvoice(req) {
			const id = `in_mock_${createHash('sha256').update(req.key).digest('hex').slice(0, 24)}`;
			const totalMinor = req.lines.reduce((a, l) => a + l.amountMinor, 0);
			const dueAt = new Date(now() + 30 * 86_400_000).toISOString();
			return { invoiceId: id, number: `MOCK-${id.slice(8, 16).toUpperCase()}`, status: 'open', totalMinor, dueAt, reused: false };
		},
		// Nothing outside this database charges for a mock subscription, so there is nothing to cancel: the row goes
		// with the account (323's cascade). No event is posted: the account's deletion follows at once.
		async cancelSubscriptions(req) {
			return [...req.subscriptionRefs];
		},
		// The same answer as Stripe's for a subscription it cancelled, with no network: a mock subscription for an
		// account that is gone has no row (323's cascade) and nothing charged a card, so nothing is refunded.
		async cancelOrphan() {
			return { cancelled: true, refunds: 0, refundedMinor: 0, skipped: false };
		}
	};
}

/** Stripe: webhooks checked with the endpoint's secret, checkout and the portal through its API with STRIPE_SECRET_KEY. */
function stripeProvider(webhookSecret: string | undefined, secretKey: string | undefined, fetchImpl: typeof fetch | undefined, now: () => number): BillingProvider {
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
		async createCheckout(account, plan, interval, urls, seats = plan.seatsIncluded) {
			const o = client();
			const prices = checkoutPrices(plan, interval, seats);
			return call(async () => {
				const made = account.customerRef ? undefined : await createCustomer(o, account.id);
				const url = await createCheckoutSession(o, {
					customer: account.customerRef ?? made!,
					accountId: account.id,
					planCode: plan.code,
					planName: plan.name,
					currency: plan.currency,
					unitAmountMinor: prices.baseMinor,
					seatsIncluded: plan.seatsIncluded,
					extraSeats: prices.extraSeats,
					extraSeatMinor: prices.extraSeatMinor,
					interval,
					environment: billingEnvironment(),
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
		},
		async changeSeats(change) {
			const o = client();
			const extraSeats = Math.max(0, change.seats - change.plan.seatsIncluded);
			return call(async () => {
				const items = await getSubscriptionItems(o, change.externalRef, change.plan.code);
				const extras = items.filter((i) => i.extraSeat);
				const base = items.find((i) => !i.extraSeat);
				// Hand-edited in the dashboard: two extra-seat items, an item we can't place, a plan item
				// at a quantity other than 1 (seatsOf counts the plan as 1, so the route's checks would be
				// off), or an extra-seat item billed at another interval than the plan. Change nothing.
				if (extras.length > 1 || !base || items.length - extras.length !== 1) throw new StripeApiError(502, 'unexpected_response', 'items');
				const extra = extras[0] ?? null;
				if (base.quantity !== 1 || (extra !== null && extra.interval !== base.interval)) throw new StripeApiError(502, 'unexpected_response', 'items');
				const interval = base.interval;
				const extraSeatMinor = interval === 'year' ? change.plan.extraSeatAnnualMinor : change.plan.extraSeatMonthlyMinor;
				if (!interval || extraSeatMinor === null) throw new StripeApiError(502, 'unexpected_response', 'interval');
				const productId = extra === null && extraSeats > 0 ? await ensureExtraSeatProduct(o, change.plan.code, change.plan.name) : undefined;
				// Same change in the same minute (a double click, a retried request): one change at Stripe.
				const minute = Math.floor(now() / 60_000);
				await changeSeatItem(o, {
					subscriptionId: change.externalRef,
					itemId: extra?.id ?? null,
					extraSeats,
					productId,
					extraSeatMinor,
					currency: base.currency ?? change.plan.currency,
					interval,
					idempotencyKey: `wm-seats-${change.externalRef}-${extra?.id ?? 'none'}-${extra?.quantity ?? 0}-${extraSeats}-${minute}`
				});
			});
		},
		async createInvoice(req) {
			const o = client();
			return call(async () => {
				const made = req.account.customerRef ? undefined : await createCustomer(o, req.account.id);
				const r = await createStripeInvoice(o, {
					customer: req.account.customerRef ?? made!,
					accountId: req.account.id,
					planCode: req.planCode,
					seats: req.seats,
					interval: req.interval,
					currency: req.currency,
					poNumber: req.poNumber,
					periodStart: req.periodStart,
					periodEnd: req.periodEnd,
					lines: req.lines,
					key: req.key
				});
				const out: InvoiceResult = {
					invoiceId: r.invoiceId,
					number: r.number,
					status: r.status,
					totalMinor: r.totalMinor,
					dueAt: r.dueDate === null ? null : new Date(r.dueDate * 1000).toISOString(),
					reused: r.reused
				};
				return made ? { ...out, newCustomerRef: made } : out;
			});
		},
		// First the customer's open Checkout sessions are expired, so none can start a subscription for an account that
		// is about to go (Stripe would charge the card and our webhook would ignore the unknown account). Then the
		// customer's open subscriptions (one we never recorded included: a checkout completed meanwhile, or whose webhook
		// hasn't landed) and any recorded one the list didn't name (no customer stored), each cancelled now with no proration.
		async cancelSubscriptions(req) {
			const o = client();
			return call(async () => {
				if (req.customerRef) for (const id of await listOpenCheckoutSessions(o, req.customerRef)) await expireCheckoutSession(o, id);
				const open = req.customerRef ? await listOpenSubscriptions(o, req.customerRef) : [];
				const refs = [...new Set([...open, ...(req.customerRef ? [] : req.subscriptionRefs)])];
				for (const ref of refs) await cancelSubscription(o, ref);
				// A recorded ref the customer's list left out has already ended at Stripe (its webhook may not have landed).
				return [...new Set([...refs, ...req.subscriptionRefs])];
			});
		},
		async cancelOrphan(req) {
			const o = client();
			return call(() => orphanCancelAndRefund(o, req.subscriptionRef, req.accountId, now()));
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
	},
	changeSeats: async () => {
		throw new BillingUnavailableError();
	},
	// manual is "the operator records it by hand": the invoice is sent from Stripe's dashboard (docs/billing.md § Staff grants).
	createInvoice: async () => {
		throw new BillingUnavailableError();
	},
	// A grant has nothing at a provider; a provider subscription can't be cancelled from here (auth/deleteAccount.ts refuses).
	cancelSubscriptions: async () => {
		throw new BillingUnavailableError();
	},
	// manual takes no webhooks, so no orphan reaches it.
	cancelOrphan: async () => {
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
	return stripeProvider(webhookSecret, env.STRIPE_SECRET_KEY?.trim() || undefined, deps.fetch, deps.now ?? Date.now);
}
