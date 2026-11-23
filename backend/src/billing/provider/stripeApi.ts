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
	const headers: Record<string, string> = {
		Authorization: `Bearer ${o.secretKey}`,
		'Content-Type': 'application/x-www-form-urlencoded',
		'Stripe-Version': STRIPE_API_VERSION
	};
	if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
	const res = await (o.fetch ?? fetch)(`${o.base ?? STRIPE_API_BASE}${path}`, {
		method: 'POST',
		headers,
		body: formEncode(params),
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
	interval: 'month' | 'year';
	successUrl: string;
	cancelUrl: string;
}

/**
 * A subscription-mode Checkout session. The price is inline (price_data) from
 * our plan table, so the table stays the one source of prices; the metadata
 * on the session and the subscription is what the webhook's normaliser reads
 * (provider/stripe.ts: billing_account_id, plan_code).
 */
export async function createCheckoutSession(o: StripeClientOptions, p: StripeCheckoutParams): Promise<string> {
	const metadata = { billing_account_id: p.accountId, plan_code: p.planCode };
	const s = await post(o, '/v1/checkout/sessions', {
		mode: 'subscription',
		customer: p.customer,
		client_reference_id: p.accountId,
		line_items: [
			{
				quantity: 1,
				price_data: {
					currency: p.currency.toLowerCase(),
					unit_amount: p.unitAmountMinor,
					recurring: { interval: p.interval },
					product_data: { name: `IC-WBT ${p.planName}` }
				}
			}
		],
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
