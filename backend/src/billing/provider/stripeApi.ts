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
 * (provider/stripe.ts: billing_account_id, plan_code, seats_included).
 */
export async function createCheckoutSession(o: StripeClientOptions, p: StripeCheckoutParams): Promise<string> {
	const metadata = { billing_account_id: p.accountId, plan_code: p.planCode, seats_included: String(p.seatsIncluded) };
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
