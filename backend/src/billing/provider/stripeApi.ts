// Stripe's API for checkout and the Customer Portal, over plain fetch (issue
// #641 Phase 3; docs/billing.md § Checkout and portal, where the research
// behind "fetch, not the stripe package" is recorded). Three form-encoded
// POSTs, each with the API version pinned and an idempotency key where a
// retry could make a second object:
//
//   POST /v1/customers                 the account's customer, made once (328 stores it)
//   POST /v1/checkout/sessions         a hosted Checkout session for one plan and interval
//   POST /v1/billing_portal/sessions   a Customer Portal session for the customer
//
// and, to change a Team's seats (docs/billing.md § Changing a Team's seats):
//
//   GET    /v1/subscriptions/:id                  its items, each price's product expanded
//   POST   /v1/products                           the extra-seat product, made once under a fixed id
//   POST   /v1/subscription_items                 add the extra-seat item (price_data names a product id)
//   POST   /v1/subscription_items/:id             its new quantity
//   DELETE /v1/subscription_items/:id             remove it, back to the included seats
//
// and, for a B2B invoice from the staff tool (docs/billing.md § B2B invoices):
//
//   GET    /v1/invoices?customer=…                the customer's invoices, to find one this key already made
//   POST   /v1/invoices                           a draft: send_invoice, days_until_due 30, the PO number as a custom field
//   POST   /v1/invoiceitems                       its lines (invoice=<id>), each an amount, a description and a period
//   POST   /v1/invoices/:id/finalize              open it (auto_advance=false: nothing advances without us)
//   POST   /v1/invoices/:id/send                  email it to the customer
//   POST   /v1/invoices/:id                       metadata wm_sent=true, so a later retry never emails it twice
//
// and, before an account is deleted (docs/billing.md § Deleting an account):
//
//   GET    /v1/checkout/sessions?customer=…&status=open   the customer's Checkout sessions still payable
//   POST   /v1/checkout/sessions/:id/expire       expire one, so it can no longer start a subscription
//   GET    /v1/subscriptions?customer=…           the customer's subscriptions not yet canceled
//   DELETE /v1/subscriptions/:id                  cancel one now: invoice_now=false, prorate=false
//
// and, for a subscription whose account is gone (orphanCancelAndRefund; docs/billing.md § Deleting an account):
//
//   GET    /v1/subscriptions/:id                  its status
//   GET    /v1/invoices?subscription=…&status=paid&created[gte]=…   its recent paid invoices, for its first (subscription_create)
//   DELETE /v1/subscriptions/:id                  cancel it now, as above, when live
//   GET    /v1/invoice_payments?invoice=…&status=paid        the first invoice's payments, when paid within the window
//   POST   /v1/refunds                            refund each payment whole, one idempotency key per payment
//
// Each change sends proration_behavior=create_prorations (Stripe's default, written
// out so a change of default never changes ours) and an idempotency key.
//
// The answer is read for its id or url only. A failure throws StripeApiError
// carrying Stripe's HTTP status and error type/code, never the key and never
// the request; the route answers it as the app's own coded 503.

/** The API version every request pins (Stripe-Version), the one stripe@23.1.0 pins (its apiVersion.js). Bump on purpose, with the normaliser's tests. */
export const STRIPE_API_VERSION = '2026-10-28.endive';
export const STRIPE_API_BASE = 'https://api.stripe.com';
/** Per request; Stripe's own client allows 80 s, a person waiting on a button needs far less. */
export const STRIPE_TIMEOUT_MS = 15_000;

export class StripeApiError extends Error {
	constructor(
		readonly status: number,
		readonly type: string | null,
		readonly code: string | null
	) {
		super(`Stripe answered ${status}${type ? ` ${type}` : ''}${code ? ` (${code})` : ''}`);
	}
}

export interface StripeClientOptions {
	secretKey: string;
	fetch?: typeof fetch;
	base?: string;
}

/** Stripe's bracketed form encoding of a nested object (`a[b][0][c]=…`); undefined and null are left out. */
export function formEncode(params: Record<string, unknown>): string {
	const out = new URLSearchParams();
	const walk = (prefix: string, v: unknown) => {
		if (v === undefined || v === null) return;
		if (Array.isArray(v)) v.forEach((item, i) => walk(`${prefix}[${i}]`, item));
		else if (typeof v === 'object') for (const [k, inner] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, inner);
		else out.append(prefix, String(v));
	};
	walk('', params);
	return out.toString();
}

async function post(o: StripeClientOptions, path: string, params: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
	return send(o, 'POST', path, params, idempotencyKey);
}

async function send(o: StripeClientOptions, method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${o.secretKey}`,
		'Stripe-Version': STRIPE_API_VERSION
	};
	const encoded = formEncode(params);
	// GET and DELETE carry their parameters in the query, as Stripe's own clients send them.
	const inQuery = method !== 'POST';
	if (!inQuery) headers['Content-Type'] = 'application/x-www-form-urlencoded';
	if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
	const url = `${o.base ?? STRIPE_API_BASE}${path}${inQuery && encoded ? `?${encoded}` : ''}`;
	const res = await (o.fetch ?? fetch)(url, {
		method,
		headers,
		...(inQuery ? {} : { body: encoded }),
		signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS)
	});
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	const obj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
	if (!res.ok) {
		const err = typeof obj.error === 'object' && obj.error !== null ? (obj.error as Record<string, unknown>) : {};
		throw new StripeApiError(res.status, typeof err.type === 'string' ? err.type : null, typeof err.code === 'string' ? err.code : null);
	}
	return obj;
}

const field = (obj: Record<string, unknown>, key: string, shape: RegExp): string => {
	const v = obj[key];
	if (typeof v !== 'string' || !shape.test(v)) throw new StripeApiError(502, 'unexpected_response', key);
	return v;
};
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{1,250}$/;
const STRIPE_URL = /^https:\/\/[a-z0-9.-]+\.stripe\.com\//;

/** A customer for the account, tagged with its id. The key makes a retry (or a double click) answer the same customer. */
export async function createCustomer(o: StripeClientOptions, accountId: string): Promise<string> {
	const c = await post(o, '/v1/customers', { metadata: { billing_account_id: accountId } }, `wm-customer-${accountId}`);
	return field(c, 'id', CUSTOMER_ID);
}

export interface StripeCheckoutParams {
	customer: string;
	accountId: string;
	planCode: string;
	planName: string;
	currency: string;
	unitAmountMinor: number;
	/** The editor seats the base price includes, recorded in the metadata for the normaliser (provider/stripe.ts). */
	seatsIncluded: number;
	/** Seats past the included ones, sold as a second line item at extraSeatMinor each; 0 sells none. */
	extraSeats: number;
	extraSeatMinor: number;
	interval: 'month' | 'year';
	/** This deployment's tag (BILLING_ENVIRONMENT, provider.ts billingEnvironment), stamped as metadata wm_environment: orphan handling acts only on its own (billing/webhook.ts). */
	environment: string;
	successUrl: string;
	cancelUrl: string;
}

/**
 * A subscription-mode Checkout session. The price is inline (price_data) from
 * our plan table, so the table stays the one source of prices: the plan at
 * quantity 1, and, when seats past the included ones are bought (Team), a
 * second line item of that many extra editor seats. No trial_period_days:
 * checkout sells no trial (docs/billing.md § Trials). The metadata on the
 * session and the subscription is what the webhook's normaliser reads
 * (provider/stripe.ts: billing_account_id, plan_code, seats_included, and
 * wm_environment, the deployment that sold it, which orphan handling checks).
 */
export async function createCheckoutSession(o: StripeClientOptions, p: StripeCheckoutParams): Promise<string> {
	const metadata = { billing_account_id: p.accountId, plan_code: p.planCode, seats_included: String(p.seatsIncluded), wm_environment: p.environment };
	const price = (unitAmount: number, name: string) => ({
		currency: p.currency.toLowerCase(),
		unit_amount: unitAmount,
		recurring: { interval: p.interval },
		product_data: { name }
	});
	const lineItems: Record<string, unknown>[] = [{ quantity: 1, price_data: price(p.unitAmountMinor, `IC-WBT ${p.planName}`) }];
	if (p.extraSeats > 0) lineItems.push({ quantity: p.extraSeats, price_data: price(p.extraSeatMinor, `IC-WBT ${p.planName}: extra editor seat`) });
	const s = await post(o, '/v1/checkout/sessions', {
		mode: 'subscription',
		customer: p.customer,
		client_reference_id: p.accountId,
		line_items: lineItems,
		metadata,
		subscription_data: { metadata },
		success_url: p.successUrl,
		cancel_url: p.cancelUrl
	});
	return field(s, 'url', STRIPE_URL);
}

/** A Customer Portal session: card, invoices, cancellation. */
export async function createPortalSession(o: StripeClientOptions, customer: string, returnUrl: string): Promise<string> {
	const s = await post(o, '/v1/billing_portal/sessions', { customer, return_url: returnUrl });
	return field(s, 'url', STRIPE_URL);
}

const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{1,250}$/;
const ITEM_ID = /^si_[A-Za-z0-9]{1,250}$/;
/** How the extra-seat item's product is named, at checkout (product_data) and here: `IC-WBT <plan>: extra editor seat`. */
export const EXTRA_SEAT_SUFFIX = ': extra editor seat';
/** The extra-seat product this code makes when it first adds the item (a fixed id, so it is made once per plan). */
export const extraSeatProductId = (planCode: string) => `wm_${planCode}_extra_seat`;

/** One subscription item as the seat change reads it. */
export interface SeatItem {
	id: string;
	quantity: number;
	/** Whether it is the extra-seat item (its product named `…: extra editor seat`, or ours by id). */
	extraSeat: boolean;
	interval: 'month' | 'year' | null;
	currency: string | null;
}

/** The subscription's items, each price's product expanded so the extra-seat item can be told from the plan's. */
export async function getSubscriptionItems(o: StripeClientOptions, subscriptionId: string, planCode: string): Promise<SeatItem[]> {
	if (!SUBSCRIPTION_ID.test(subscriptionId)) throw new StripeApiError(400, 'invalid_request', 'subscription');
	const sub = await send(o, 'GET', `/v1/subscriptions/${subscriptionId}`, { expand: ['items.data.price.product'] });
	const items = typeof sub.items === 'object' && sub.items !== null && Array.isArray((sub.items as { data?: unknown }).data) ? ((sub.items as { data: unknown[] }).data as Record<string, unknown>[]) : null;
	if (!items) throw new StripeApiError(502, 'unexpected_response', 'items');
	return items.map((item) => {
		const id = field(item, 'id', ITEM_ID);
		const quantity = typeof item.quantity === 'number' && Number.isInteger(item.quantity) && item.quantity >= 0 ? item.quantity : 1;
		const price = typeof item.price === 'object' && item.price !== null ? (item.price as Record<string, unknown>) : {};
		const product = typeof price.product === 'object' && price.product !== null ? (price.product as Record<string, unknown>) : {};
		const recurring = typeof price.recurring === 'object' && price.recurring !== null ? (price.recurring as Record<string, unknown>) : {};
		const extraSeat = product.id === extraSeatProductId(planCode) || (typeof product.name === 'string' && product.name.endsWith(EXTRA_SEAT_SUFFIX));
		const interval = recurring.interval === 'month' || recurring.interval === 'year' ? recurring.interval : null;
		return { id, quantity, extraSeat, interval, currency: typeof price.currency === 'string' ? price.currency : null };
	});
}

/** The extra-seat product, made under a fixed id the first time; Stripe's resource_already_exists means it is there. */
export async function ensureExtraSeatProduct(o: StripeClientOptions, planCode: string, planName: string): Promise<string> {
	const id = extraSeatProductId(planCode);
	try {
		await post(o, '/v1/products', { id, name: `IC-WBT ${planName}${EXTRA_SEAT_SUFFIX}` }, `wm-product-${id}`);
	} catch (e) {
		if (!(e instanceof StripeApiError && e.code === 'resource_already_exists')) throw e;
	}
	return id;
}

export interface SeatChangeParams {
	subscriptionId: string;
	/** The extra-seat item when the subscription has one. */
	itemId: string | null;
	/** Extra seats wanted: 0 removes the item. */
	extraSeats: number;
	/** For a new item: its product, price, currency and interval. */
	productId?: string;
	extraSeatMinor?: number;
	currency?: string;
	interval?: 'month' | 'year';
	/** Makes the idempotency key: the same change asked twice (a double click) is one change at Stripe. */
	idempotencyKey: string;
}

/**
 * Stripe's proration setting for every seat change: its default, written out.
 * Adding a seat mid-period charges the rest of the period on the next invoice;
 * removing one credits it. docs/billing.md records it as a decision for the
 * operator to confirm.
 */
export const SEAT_PRORATION = 'create_prorations';

/** Update, add or remove the extra-seat item. */
export async function changeSeatItem(o: StripeClientOptions, p: SeatChangeParams): Promise<void> {
	if (p.itemId !== null && !ITEM_ID.test(p.itemId)) throw new StripeApiError(400, 'invalid_request', 'item');
	if (p.extraSeats === 0) {
		if (p.itemId === null) return;
		await send(o, 'DELETE', `/v1/subscription_items/${p.itemId}`, { proration_behavior: SEAT_PRORATION }, p.idempotencyKey);
		return;
	}
	if (p.itemId !== null) {
		await post(o, `/v1/subscription_items/${p.itemId}`, { quantity: p.extraSeats, proration_behavior: SEAT_PRORATION }, p.idempotencyKey);
		return;
	}
	if (!SUBSCRIPTION_ID.test(p.subscriptionId) || !p.productId || p.extraSeatMinor === undefined || !p.currency || !p.interval) {
		throw new StripeApiError(400, 'invalid_request', 'price');
	}
	await post(
		o,
		'/v1/subscription_items',
		{
			subscription: p.subscriptionId,
			quantity: p.extraSeats,
			price_data: { currency: p.currency.toLowerCase(), product: p.productId, unit_amount: p.extraSeatMinor, recurring: { interval: p.interval } },
			proration_behavior: SEAT_PRORATION
		},
		p.idempotencyKey
	);
}

/** Stripe's subscription statuses that are over: nothing more is charged, so nothing to cancel. */
const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired']);

/**
 * The customer's subscriptions that can still charge (Stripe's list leaves out
 * canceled ones by default; incomplete_expired is over too). A customer has a
 * handful at most, so one page of 100; more than that is refused rather than
 * cancelling some and deleting the account over the rest.
 */
export async function listOpenSubscriptions(o: StripeClientOptions, customer: string): Promise<string[]> {
	if (!CUSTOMER_ID.test(customer)) throw new StripeApiError(400, 'invalid_request', 'customer');
	const list = await send(o, 'GET', '/v1/subscriptions', { customer, limit: 100 });
	if (!Array.isArray(list.data) || list.has_more === true) throw new StripeApiError(502, 'unexpected_response', 'data');
	return (list.data as Record<string, unknown>[]).filter((s) => !ENDED_STATUSES.has(String(s.status))).map((s) => field(s, 'id', SUBSCRIPTION_ID));
}

/**
 * Cancel a subscription now, with no final invoice and no proration credit
 * (written out, though both are Stripe's defaults, so a change of default never
 * changes ours): the period already paid is not refunded, as cancelling from the
 * portal refunds nothing (docs/billing.md § Deleting an account). A subscription
 * Stripe no longer has (resource_missing) is as good as cancelled.
 */
export async function cancelSubscription(o: StripeClientOptions, subscriptionId: string): Promise<void> {
	if (!SUBSCRIPTION_ID.test(subscriptionId)) throw new StripeApiError(400, 'invalid_request', 'subscription');
	try {
		const sub = await send(o, 'DELETE', `/v1/subscriptions/${subscriptionId}`, { invoice_now: false, prorate: false });
		if (sub.status !== 'canceled') throw new StripeApiError(502, 'unexpected_response', 'status');
	} catch (e) {
		if (e instanceof StripeApiError && e.status === 404 && e.code === 'resource_missing') return;
		throw e;
	}
}

const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]{1,250}$/;

/**
 * The customer's Checkout sessions still open (status=open): each could still
 * be paid and start a subscription after the account is gone. Every session we
 * make names the customer (createCheckoutSession), so listing by customer finds
 * them all. One page of 100; more is refused, as for subscriptions.
 */
export async function listOpenCheckoutSessions(o: StripeClientOptions, customer: string): Promise<string[]> {
	if (!CUSTOMER_ID.test(customer)) throw new StripeApiError(400, 'invalid_request', 'customer');
	const list = await send(o, 'GET', '/v1/checkout/sessions', { customer, status: 'open', limit: 100 });
	if (!Array.isArray(list.data) || list.has_more === true) throw new StripeApiError(502, 'unexpected_response', 'data');
	return (list.data as Record<string, unknown>[]).map((s) => field(s, 'id', CHECKOUT_SESSION_ID));
}

/**
 * Expire an open Checkout session, so it can no longer be paid. Stripe refuses
 * (400 invalid_request_error) a session that is no longer open: one that
 * expired meanwhile, or was completed in the moment between the list and this
 * call. Either is fine here: a completed one's subscription already exists, and
 * the subscription list read after the expiries (cancelSubscriptions in
 * provider.ts) cancels it. A missing session is as good as expired.
 */
export async function expireCheckoutSession(o: StripeClientOptions, sessionId: string): Promise<void> {
	if (!CHECKOUT_SESSION_ID.test(sessionId)) throw new StripeApiError(400, 'invalid_request', 'session');
	try {
		const s = await post(o, `/v1/checkout/sessions/${sessionId}/expire`, {});
		if (s.status !== 'expired') throw new StripeApiError(502, 'unexpected_response', 'status');
	} catch (e) {
		if (e instanceof StripeApiError && (e.status === 400 || e.status === 404) && e.type === 'invalid_request_error') return;
		throw e;
	}
}

const INVOICE_ID = /^in_[A-Za-z0-9]{1,250}$/;
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9]{1,250}$/;
const CHARGE_ID = /^(ch|py)_[A-Za-z0-9]{1,250}$/;

/**
 * How recently an orphan's first invoice must have been paid for it to be
 * refunded: Stripe's automatic webhook retries in live mode (up to three days,
 * docs.stripe.com/webhooks § Automatic retries) plus one day's margin for a
 * delivery that lands at the very end of them, clock skew and the operator
 * resending it by hand promptly. A checkout paid after its account was deleted
 * reaches us within this window; an event for a subscription paid longer ago
 * is a late or replayed event about one the account used, never refunded
 * (docs/billing.md § Deleting an account).
 */
export const ORPHAN_REFUND_WINDOW_SECONDS = 4 * 24 * 60 * 60;

/** Which step of orphanCancelAndRefund failed: logged by the webhook (never the error's message or Stripe's payload). */
export type OrphanStep = 'read' | 'list' | 'cancel' | 'payments' | 'refund';

/** Tag a failure with the step it came from, so the webhook can log where it stopped. */
async function at<T>(step: OrphanStep, f: () => Promise<T>): Promise<T> {
	try {
		return await f();
	} catch (e) {
		if (e instanceof Error && !('step' in e)) Object.assign(e, { step });
		throw e;
	}
}

/** What cancelling and refunding an orphaned subscription did (orphanCancelAndRefund). */
export interface OrphanResult {
	/** Whether this call cancelled it (false: Stripe had it ended already, or doesn't have it). */
	cancelled: boolean;
	/** Refunds this call made (an idempotent replay of an earlier one counts again; an already refunded payment doesn't). */
	refunds: number;
	/** Their total, in the currency's minor units. */
	refundedMinor: number;
	/**
	 * Nothing was done: the subscription had already ended and its first invoice wasn't paid within
	 * ORPHAN_REFUND_WINDOW_SECONDS (a late event about a subscription its account used), so it is
	 * neither cancelled nor refunded. The webhook records it `orphan_skipped`.
	 */
	skipped: boolean;
}

/** Refund errors that mean there is nothing left to refund: refunded already, or charged back (the dispute returns it). */
const NOTHING_TO_REFUND = new Set(['charge_already_refunded', 'charge_disputed', 'refund_disputed_payment']);

/**
 * A subscription whose account is gone (a checkout paid after the account was
 * deleted; docs/billing.md § Deleting an account): cancel it now and refund
 * the checkout's payment, its first invoice (billing_reason
 * `subscription_create`), when that was paid within
 * ORPHAN_REFUND_WINDOW_SECONDS of `nowMs`. No other invoice is ever refunded:
 * a renewal is a month or year the subscription was live for.
 *
 *   GET    /v1/subscriptions/:id                          its status: an ended one isn't cancelled again
 *   GET    /v1/invoices?subscription=…&status=paid&created[gte]=<window start>
 *                                                         its paid invoices made within the window (Stripe's list
 *                                                         filters no billing_reason, so the first is picked here)
 *   DELETE /v1/subscriptions/:id                          cancel now, when live (cancelSubscription: no final invoice, no proration)
 *   GET    /v1/invoice_payments?invoice=…&status=paid     the first invoice's payments (API 2025-03-31.basil moved them off the invoice)
 *   POST   /v1/refunds                                    the whole of each payment, Idempotency-Key wm-orphan-refund-<payment>
 *
 * A subscription already ended whose first invoice is older than the window
 * (or was never paid) is left alone: `skipped`, nothing cancelled, nothing
 * refunded. That is a late or out-of-order event (a subscription its account
 * paid for and used, cancelled when the account was deleted), not a checkout
 * paid after the delete. A live one is always cancelled (its account is gone,
 * so nothing should charge again), and refunded only inside the window.
 *
 * Each step is safe to repeat, so a redelivered webhook (or two events for the
 * same subscription) refunds once: a retry after a cancel whose refund failed
 * finds it ended with a recent first invoice and refunds it; a payment refunded
 * already (charge_already_refunded, past the key's 24 hours) or charged back is
 * skipped. A trial (nothing paid) is only cancelled. Any other failure throws,
 * tagged with its step (OrphanStep), so the webhook answers non-2xx and Stripe
 * retries. Refunds carry `reason=requested_by_customer` and metadata naming why
 * and the billing account's random id, never an address.
 */
export async function orphanCancelAndRefund(o: StripeClientOptions, subscriptionId: string, accountId: string, nowMs: number = Date.now()): Promise<OrphanResult> {
	if (!SUBSCRIPTION_ID.test(subscriptionId)) throw new StripeApiError(400, 'invalid_request', 'subscription');
	const live = await at('read', async () => {
		try {
			const sub = await send(o, 'GET', `/v1/subscriptions/${subscriptionId}`, {});
			return !ENDED_STATUSES.has(String(sub.status));
		} catch (e) {
			if (e instanceof StripeApiError && e.status === 404 && e.code === 'resource_missing') return false;
			throw e;
		}
	});
	const windowStart = Math.floor(nowMs / 1000) - ORPHAN_REFUND_WINDOW_SECONDS;
	const first = await at('list', async () => {
		const invoices = await send(o, 'GET', '/v1/invoices', { subscription: subscriptionId, status: 'paid', created: { gte: windowStart }, limit: 100 });
		if (!Array.isArray(invoices.data) || invoices.has_more === true) throw new StripeApiError(502, 'unexpected_response', 'data');
		const found = (invoices.data as Record<string, unknown>[]).find((inv) => {
			if (inv.billing_reason !== 'subscription_create') return false;
			const paidAt = typeof inv.status_transitions === 'object' && inv.status_transitions !== null ? (inv.status_transitions as Record<string, unknown>).paid_at : null;
			return typeof paidAt === 'number' && paidAt >= windowStart;
		});
		return found ? { id: field(found, 'id', INVOICE_ID), amountPaid: found.amount_paid } : null;
	});
	if (!live && first === null) return { cancelled: false, refunds: 0, refundedMinor: 0, skipped: true };
	let cancelled = false;
	if (live) {
		await at('cancel', () => cancelSubscription(o, subscriptionId));
		cancelled = true;
	}
	let refunds = 0;
	let refundedMinor = 0;
	if (first === null || (typeof first.amountPaid === 'number' && first.amountPaid <= 0)) return { cancelled, refunds, refundedMinor, skipped: false };
	const payments = await at('payments', async () => {
		const list = await send(o, 'GET', '/v1/invoice_payments', { invoice: first.id, status: 'paid', limit: 100 });
		if (!Array.isArray(list.data) || list.has_more === true) throw new StripeApiError(502, 'unexpected_response', 'data');
		return list.data as Record<string, unknown>[];
	});
	for (const p of payments) {
		await at('refund', async () => {
			const payment = typeof p.payment === 'object' && p.payment !== null ? (p.payment as Record<string, unknown>) : {};
			const target =
				payment.type === 'payment_intent'
					? { payment_intent: field(payment, 'payment_intent', PAYMENT_INTENT_ID) }
					: payment.type === 'charge'
						? { charge: field(payment, 'charge', CHARGE_ID) }
						: null;
			if (!target) throw new StripeApiError(502, 'unexpected_response', 'payment');
			const ref = 'payment_intent' in target ? target.payment_intent : target.charge;
			try {
				const refund = await post(
					o,
					'/v1/refunds',
					{ ...target, reason: 'requested_by_customer', metadata: { wm_reason: 'account_deleted', billing_account_id: accountId } },
					`wm-orphan-refund-${ref}`
				);
				if (refund.status === 'failed' || refund.status === 'canceled') throw new StripeApiError(502, 'unexpected_response', 'status');
				refunds += 1;
				if (typeof refund.amount === 'number') refundedMinor += refund.amount;
			} catch (e) {
				if (e instanceof StripeApiError && e.code !== null && NOTHING_TO_REFUND.has(e.code)) return;
				throw e;
			}
		});
	}
	return { cancelled, refunds, refundedMinor, skipped: false };
}

/** Days a B2B invoice gives the customer to pay (net 30; issue #641 Phase 5). */
export const INVOICE_DAYS_UNTIL_DUE = 30;
/** The custom field the PO number goes in, printed on the invoice and its PDF (Stripe: up to 4 fields, name ≤ 40, value ≤ 140). */
export const PO_FIELD_NAME = 'PO number';

export interface InvoiceLine {
	/** The line's total in minor units (quantity × unit price, worked out by the caller). */
	amountMinor: number;
	/** What the customer reads on the line, quantity included ("IC-WBT Team: 3 editor seats, 1 year"). */
	description: string;
}

export interface StripeInvoiceParams {
	customer: string;
	accountId: string;
	planCode: string;
	seats: number;
	interval: 'month' | 'year';
	currency: string;
	poNumber: string;
	/** The period the invoice pays for, as unix seconds (start inclusive, end exclusive), printed on each line. */
	periodStart: number;
	periodEnd: number;
	lines: InvoiceLine[];
	/** Our key for this invoice: in its metadata (wm_invoice_key), to find it again, and the stem of every idempotency key. */
	key: string;
}

export interface StripeInvoiceResult {
	invoiceId: string;
	/** Stripe's invoice number once finalized (e.g. ABCD1234-0001). */
	number: string | null;
	status: string;
	totalMinor: number;
	/** Unix seconds. */
	dueDate: number | null;
	/** An invoice this key had already made and sent: nothing new was made or emailed. */
	reused: boolean;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const meta = (o: Record<string, unknown>): Record<string, unknown> => (typeof o.metadata === 'object' && o.metadata !== null ? (o.metadata as Record<string, unknown>) : {});

/** The customer's invoice this key made, if any (void ones left out: voided means the operator cancelled it). */
async function findInvoice(o: StripeClientOptions, customer: string, key: string): Promise<Record<string, unknown> | null> {
	const list = await send(o, 'GET', '/v1/invoices', { customer, limit: 100 });
	const data = Array.isArray(list.data) ? (list.data as Record<string, unknown>[]) : null;
	if (!data) throw new StripeApiError(502, 'unexpected_response', 'data');
	return data.find((inv) => meta(inv).wm_invoice_key === key && inv.status !== 'void') ?? null;
}

/**
 * What a B2B invoice's metadata carries: everything its invoice.paid needs to grant the plan
 * (provider/stripe.ts invoiceGrantOf, app_billing_apply 335), and our key. Stripe keeps metadata values as strings.
 */
export function invoiceMetadata(p: Pick<StripeInvoiceParams, 'accountId' | 'planCode' | 'seats' | 'interval' | 'periodStart' | 'periodEnd' | 'key' | 'lines'>): Record<string, string> {
	return {
		billing_account_id: p.accountId,
		plan_code: p.planCode,
		seats: String(p.seats),
		interval: p.interval,
		period_start: String(p.periodStart),
		period_end: String(p.periodEnd),
		// The total as issued: the paid invoice must cover it (335), so a price change after issue never refuses a paid invoice.
		amount_minor: String(p.lines.reduce((a, l) => a + l.amountMinor, 0)),
		wm_invoice_key: p.key
	};
}

/**
 * A B2B invoice, made once per key and sent once: a send_invoice draft due in
 * INVOICE_DAYS_UNTIL_DUE days with the PO number as a custom field, its lines,
 * finalized and emailed. Every POST carries an idempotency key from `key` (a
 * retry within Stripe's 24 hours answers the same object), and the invoice
 * carries `key` in its metadata, so a retry after that finds it instead of
 * making a second one: a draft is completed, an open one not yet sent is sent,
 * a sent one is answered as it is (`reused`).
 */
export async function createInvoice(o: StripeClientOptions, p: StripeInvoiceParams): Promise<StripeInvoiceResult> {
	if (!CUSTOMER_ID.test(p.customer)) throw new StripeApiError(400, 'invalid_request', 'customer');
	if (p.lines.length === 0 || p.lines.some((l) => !Number.isInteger(l.amountMinor) || l.amountMinor <= 0)) throw new StripeApiError(400, 'invalid_request', 'lines');
	const k = `wm-invoice-${p.key}`;
	const expected = p.lines.reduce((a, l) => a + l.amountMinor, 0);
	const metadata = invoiceMetadata(p);
	let inv = await findInvoice(o, p.customer, p.key);
	const reused = inv !== null && inv.status !== 'draft' && meta(inv).wm_sent === 'true';
	if (!inv) {
		inv = await post(
			o,
			'/v1/invoices',
			{
				customer: p.customer,
				collection_method: 'send_invoice',
				days_until_due: INVOICE_DAYS_UNTIL_DUE,
				currency: p.currency.toLowerCase(),
				custom_fields: [{ name: PO_FIELD_NAME, value: p.poNumber }],
				pending_invoice_items_behavior: 'exclude',
				auto_advance: false,
				metadata
			},
			k
		);
	}
	const id = field(inv, 'id', INVOICE_ID);
	if (inv.status === 'draft') {
		// A draft this key made earlier may already hold its lines (a retry after a failure past this step).
		const total = num(inv.total) ?? 0;
		if (total !== 0 && total !== expected) throw new StripeApiError(502, 'unexpected_response', 'total');
		if (total === 0) {
			for (const [i, l] of p.lines.entries()) {
				await post(
					o,
					'/v1/invoiceitems',
					{
						customer: p.customer,
						invoice: id,
						currency: p.currency.toLowerCase(),
						amount: l.amountMinor,
						description: l.description,
						period: { start: p.periodStart, end: p.periodEnd },
						metadata: { billing_account_id: p.accountId, wm_invoice_key: p.key }
					},
					`${k}-item-${i}`
				);
			}
		}
		inv = await post(o, `/v1/invoices/${id}/finalize`, { auto_advance: false }, `${k}-finalize`);
	}
	if (!reused) {
		if (inv.status !== 'open') throw new StripeApiError(502, 'unexpected_response', 'status');
		// Sending answers the invoice, but the metadata write below answers it again with wm_sent: that one is kept.
		await post(o, `/v1/invoices/${id}/send`, {}, `${k}-send`);
		inv = await post(o, `/v1/invoices/${id}`, { metadata: { wm_sent: 'true' } }, `${k}-sent`);
	}
	return {
		invoiceId: id,
		number: typeof inv.number === 'string' ? inv.number : null,
		status: typeof inv.status === 'string' ? inv.status : 'unknown',
		totalMinor: num(inv.total) ?? expected,
		dueDate: num(inv.due_date),
		reused
	};
}
