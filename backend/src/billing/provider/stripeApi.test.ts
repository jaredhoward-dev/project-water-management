// Stripe's API over fetch (stripeApi.ts) with the HTTP layer mocked: never a
// live call. What each request sends (path, headers, form body) and how each
// answer is read or refused.
import { describe, expect, it, vi } from 'vitest';
import { createCheckoutSession, createCustomer, createPortalSession, formEncode, STRIPE_API_VERSION, StripeApiError } from './stripeApi.js';

const KEY = 'test-only-not-a-stripe-key';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';

function fakeFetch(status: number, body: unknown) {
	const calls: { url: string; init: RequestInit }[] = [];
	const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init! });
		return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	});
	return { f: f as unknown as typeof fetch, calls };
}
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));
const headers = (init: RequestInit) => init.headers as Record<string, string>;

describe('formEncode', () => {
	it('writes Stripe’s bracketed form, arrays by index, leaving out null and undefined', () => {
		const out = new URLSearchParams(formEncode({ a: 1, b: { c: 'x', d: [{ e: true }] }, n: null, u: undefined }));
		expect([...out]).toEqual([
			['a', '1'],
			['b[c]', 'x'],
			['b[d][0][e]', 'true']
		]);
	});
});

describe('createCustomer', () => {
	it('posts the account id as metadata, with the pinned version, the key and an idempotency key per account', async () => {
		const { f, calls } = fakeFetch(200, { id: 'cus_Test123', object: 'customer' });
		expect(await createCustomer({ secretKey: KEY, fetch: f }, ACCOUNT)).toBe('cus_Test123');
		expect(calls[0]!.url).toBe('https://api.stripe.com/v1/customers');
		expect(calls[0]!.init.method).toBe('POST');
		expect(headers(calls[0]!.init)).toMatchObject({
			Authorization: `Bearer ${KEY}`,
			'Stripe-Version': STRIPE_API_VERSION,
			'Content-Type': 'application/x-www-form-urlencoded',
			'Idempotency-Key': `wm-customer-${ACCOUNT}`
		});
		expect(form(calls[0]!.init)).toEqual({ 'metadata[billing_account_id]': ACCOUNT });
	});

	it('refuses an answer without a customer id', async () => {
		const { f } = fakeFetch(200, { id: 'not-a-customer' });
		await expect(createCustomer({ secretKey: KEY, fetch: f }, ACCOUNT)).rejects.toBeInstanceOf(StripeApiError);
	});
});

describe('createCheckoutSession', () => {
	const params = {
		customer: 'cus_Test123',
		accountId: ACCOUNT,
		planCode: 'pro',
		planName: 'Pro',
		currency: 'ZAR',
		unitAmountMinor: 89900,
		seatsIncluded: 1,
		extraSeats: 0,
		extraSeatMinor: 0,
		interval: 'month' as const,
		successUrl: 'https://site.example/account/plan?checkout=done',
		cancelUrl: 'https://site.example/account/plan?checkout=cancelled'
	};

	it('makes a subscription session at the plan table’s price, with the metadata the webhook reads on the session and the subscription', async () => {
		const { f, calls } = fakeFetch(200, { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
		expect(await createCheckoutSession({ secretKey: KEY, fetch: f }, params)).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
		expect(calls[0]!.url).toBe('https://api.stripe.com/v1/checkout/sessions');
		expect(form(calls[0]!.init)).toEqual({
			mode: 'subscription',
			customer: 'cus_Test123',
			client_reference_id: ACCOUNT,
			'line_items[0][quantity]': '1',
			'line_items[0][price_data][currency]': 'zar',
			'line_items[0][price_data][unit_amount]': '89900',
			'line_items[0][price_data][recurring][interval]': 'month',
			'line_items[0][price_data][product_data][name]': 'IC-WBT Pro',
			'metadata[billing_account_id]': ACCOUNT,
			'metadata[plan_code]': 'pro',
			'metadata[seats_included]': '1',
			'subscription_data[metadata][billing_account_id]': ACCOUNT,
			'subscription_data[metadata][plan_code]': 'pro',
			'subscription_data[metadata][seats_included]': '1',
			success_url: params.successUrl,
			cancel_url: params.cancelUrl
		});
	});

	it('sells Team’s extra seats as a second line item at the extra-seat price, and never a trial', async () => {
		const { f, calls } = fakeFetch(200, { id: 'cs_test_2', url: 'https://checkout.stripe.com/c/pay/cs_test_2' });
		const team = { ...params, planCode: 'team', planName: 'Team', unitAmountMinor: 2499000, seatsIncluded: 3, extraSeats: 2, extraSeatMinor: 499000, interval: 'year' as const };
		await createCheckoutSession({ secretKey: KEY, fetch: f }, team);
		const body = form(calls[0]!.init);
		expect(body).toMatchObject({
			'line_items[0][quantity]': '1',
			'line_items[0][price_data][unit_amount]': '2499000',
			'line_items[0][price_data][recurring][interval]': 'year',
			'line_items[0][price_data][product_data][name]': 'IC-WBT Team',
			'line_items[1][quantity]': '2',
			'line_items[1][price_data][currency]': 'zar',
			'line_items[1][price_data][unit_amount]': '499000',
			'line_items[1][price_data][recurring][interval]': 'year',
			'line_items[1][price_data][product_data][name]': 'IC-WBT Team: extra editor seat',
			'metadata[seats_included]': '3',
			'subscription_data[metadata][seats_included]': '3'
		});
		expect(Object.keys(body).some((k) => k.includes('trial'))).toBe(false);
		expect(Object.keys(body).some((k) => k.startsWith('line_items[2]'))).toBe(false);
	});

	it('throws Stripe’s status, type and code, never its message, on an error answer', async () => {
		const { f } = fakeFetch(400, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such customer: cus_x' } });
		const e = await createCheckoutSession({ secretKey: KEY, fetch: f }, params).catch((x: unknown) => x);
		expect(e).toBeInstanceOf(StripeApiError);
		expect(e).toMatchObject({ status: 400, type: 'invalid_request_error', code: 'resource_missing' });
		expect(String((e as Error).message)).not.toContain('cus_x');
	});

	it('refuses a session URL that isn’t Stripe’s (an https page on stripe.com)', async () => {
		for (const url of ['http://checkout.stripe.com/x', 'https://evil.example/x', 'https://stripe.com.evil.example/x', null]) {
			const { f } = fakeFetch(200, { id: 'cs_test_1', url });
			await expect(createCheckoutSession({ secretKey: KEY, fetch: f }, params), String(url)).rejects.toBeInstanceOf(StripeApiError);
		}
	});

	it('survives a non-JSON error body', async () => {
		const { f } = fakeFetch(502, '<html>bad gateway</html>');
		await expect(createCheckoutSession({ secretKey: KEY, fetch: f }, params)).rejects.toMatchObject({ status: 502, type: null });
	});
});

describe('createPortalSession', () => {
	it('opens the portal for the customer, coming back to the plan page', async () => {
		const { f, calls } = fakeFetch(200, { id: 'bps_1', url: 'https://billing.stripe.com/p/session/test_1' });
		expect(await createPortalSession({ secretKey: KEY, fetch: f }, 'cus_Test123', 'https://site.example/account/plan')).toBe('https://billing.stripe.com/p/session/test_1');
		expect(calls[0]!.url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
		expect(form(calls[0]!.init)).toEqual({ customer: 'cus_Test123', return_url: 'https://site.example/account/plan' });
		expect(headers(calls[0]!.init)['Idempotency-Key']).toBeUndefined();
	});
});
