// Stripe's API over fetch (stripeApi.ts) with the HTTP layer mocked: never a
// live call. What each request sends (path, headers, form body) and how each
// answer is read or refused.
import { describe, expect, it, vi } from 'vitest';
import { cancelSubscription, ORPHAN_REFUND_WINDOW_SECONDS, orphanCancelAndRefund, createCheckoutSession, createCustomer, expireCheckoutSession, listOpenCheckoutSessions, listOpenSubscriptions, createInvoice, createPortalSession, FIND_INVOICE_MAX_PAGES, formEncode, STRIPE_API_VERSION, StripeApiError } from './stripeApi.js';

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
		environment: 'icwbt.example.com',
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
			'metadata[wm_environment]': 'icwbt.example.com',
			'subscription_data[metadata][billing_account_id]': ACCOUNT,
			'subscription_data[metadata][plan_code]': 'pro',
			'subscription_data[metadata][seats_included]': '1',
			// The deployment that sold it: the webhook refunds an orphan only when this is its own (webhook.ts).
			'subscription_data[metadata][wm_environment]': 'icwbt.example.com',
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

describe('createInvoice (B2B, from the staff tool)', () => {
	const params = {
		customer: 'cus_Test123',
		accountId: ACCOUNT,
		planCode: 'team',
		seats: 5,
		interval: 'year' as const,
		currency: 'ZAR',
		poNumber: 'PO-2026/0042',
		periodStart: 1798754400,
		periodEnd: 1830290400,
		lines: [
			{ amountMinor: 2499000, description: 'IC-WBT Team (3 editor seats), 1 year' },
			{ amountMinor: 998000, description: 'IC-WBT Team: 2 extra editor seats, 1 year' }
		],
		key: `${ACCOUNT}-abc`
	};
	/** A scripted Stripe: each request answered in turn by path. */
	function scripted(answers: Record<string, unknown[]>) {
		const calls: { method: string; url: string; init: RequestInit }[] = [];
		const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const u = new URL(String(url));
			calls.push({ method: init!.method!, url: String(url), init: init! });
			const key = `${init!.method} ${u.pathname}`;
			const queue = answers[key];
			if (!queue?.length) return new Response(JSON.stringify({ error: { type: 'invalid_request_error' } }), { status: 400 });
			return new Response(JSON.stringify(queue.shift()), { status: 200 });
		});
		return { f: f as unknown as typeof fetch, calls };
	}
	const draft = { id: 'in_New1', status: 'draft', total: 0, metadata: { wm_invoice_key: params.key } };
	const open = { id: 'in_New1', status: 'open', total: 3497000, number: 'ABCD-0001', due_date: 1801346400, metadata: { wm_invoice_key: params.key } };

	it('makes a send_invoice draft due in 30 days with the PO number as a custom field, adds its lines, finalizes, sends, and marks it sent', async () => {
		const { f, calls } = scripted({
			'GET /v1/invoices': [{ object: 'list', data: [] }],
			'POST /v1/invoices': [draft],
			'POST /v1/invoiceitems': [{ id: 'ii_1' }, { id: 'ii_2' }],
			'POST /v1/invoices/in_New1/finalize': [open],
			'POST /v1/invoices/in_New1/send': [open],
			'POST /v1/invoices/in_New1': [{ ...open, metadata: { ...open.metadata, wm_sent: 'true' } }]
		});
		const r = await createInvoice({ secretKey: KEY, fetch: f }, params);
		expect(r).toEqual({ invoiceId: 'in_New1', number: 'ABCD-0001', status: 'open', totalMinor: 3497000, dueDate: 1801346400, reused: false });
		expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			'GET /v1/invoices',
			'POST /v1/invoices',
			'POST /v1/invoiceitems',
			'POST /v1/invoiceitems',
			'POST /v1/invoices/in_New1/finalize',
			'POST /v1/invoices/in_New1/send',
			'POST /v1/invoices/in_New1'
		]);
		expect(new URL(calls[0]!.url).searchParams.get('customer')).toBe('cus_Test123');
		expect(form(calls[1]!.init)).toEqual({
			customer: 'cus_Test123',
			collection_method: 'send_invoice',
			days_until_due: '30',
			currency: 'zar',
			'custom_fields[0][name]': 'PO number',
			'custom_fields[0][value]': 'PO-2026/0042',
			pending_invoice_items_behavior: 'exclude',
			auto_advance: 'false',
			'metadata[billing_account_id]': ACCOUNT,
			'metadata[plan_code]': 'team',
			'metadata[seats]': '5',
			'metadata[interval]': 'year',
			'metadata[period_start]': '1798754400',
			'metadata[period_end]': '1830290400',
			'metadata[amount_minor]': '3497000',
			'metadata[wm_invoice_key]': params.key
		});
		expect(form(calls[2]!.init)).toEqual({
			customer: 'cus_Test123',
			invoice: 'in_New1',
			currency: 'zar',
			amount: '2499000',
			description: 'IC-WBT Team (3 editor seats), 1 year',
			'period[start]': '1798754400',
			'period[end]': '1830290400',
			'metadata[billing_account_id]': ACCOUNT,
			'metadata[wm_invoice_key]': params.key
		});
		expect(form(calls[3]!.init).amount).toBe('998000');
		expect(form(calls[4]!.init)).toEqual({ auto_advance: 'false' });
		expect(form(calls[6]!.init)).toEqual({ 'metadata[wm_sent]': 'true' });
		// Every write pinned and idempotent, each with its own key from the invoice's.
		const keys = calls.slice(1).map((c) => headers(c.init)['Idempotency-Key']);
		expect(new Set(keys).size).toBe(keys.length);
		for (const c of calls) expect(headers(c.init)['Stripe-Version']).toBe(STRIPE_API_VERSION);
		for (const k of keys) expect(k).toMatch(new RegExp(`^wm-invoice-${params.key}`));
	});

	it('answers an invoice this key already made and sent as it is: nothing new made, nothing emailed twice', async () => {
		const sent = { ...open, metadata: { ...open.metadata, wm_sent: 'true' } };
		const { f, calls } = scripted({ 'GET /v1/invoices': [{ object: 'list', data: [{ id: 'in_Other', status: 'open', metadata: {} }, sent] }] });
		expect(await createInvoice({ secretKey: KEY, fetch: f }, params)).toMatchObject({ invoiceId: 'in_New1', reused: true });
		expect(calls).toHaveLength(1);
	});

	it('pages past the newest 100 invoices with starting_after: finds this key’s invoice on page 2', async () => {
		const sent = { ...open, metadata: { ...open.metadata, wm_sent: 'true' } };
		const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `in_Old${i}`, status: 'paid', metadata: {} }));
		const { f, calls } = scripted({
			'GET /v1/invoices': [
				{ object: 'list', has_more: true, data: page1 },
				{ object: 'list', has_more: false, data: [sent] }
			]
		});
		expect(await createInvoice({ secretKey: KEY, fetch: f }, params)).toMatchObject({ invoiceId: 'in_New1', reused: true });
		expect(calls).toHaveLength(2);
		const q = calls.map((c) => new URL(c.url).searchParams);
		expect(q[0]!.get('starting_after')).toBeNull();
		expect(q[1]!.get('starting_after')).toBe('in_Old99');
		for (const p of q) expect([p.get('customer'), p.get('limit')]).toEqual(['cus_Test123', '100']);
	});

	it('makes a new invoice once every page is read without a match (has_more false ends the paging)', async () => {
		const { f, calls } = scripted({
			'GET /v1/invoices': [
				{ object: 'list', has_more: true, data: [{ id: 'in_A', status: 'paid', metadata: {} }] },
				{ object: 'list', has_more: false, data: [{ id: 'in_B', status: 'paid', metadata: { wm_invoice_key: 'someone-else' } }] }
			],
			'POST /v1/invoices': []
		});
		// The POST is unanswered (400): what matters is that the lookup ended and creation was tried.
		await expect(createInvoice({ secretKey: KEY, fetch: f }, params)).rejects.toBeInstanceOf(StripeApiError);
		expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST']);
	});

	it(`refuses, logs and makes nothing after ${FIND_INVOICE_MAX_PAGES} pages, and refuses has_more with no cursor`, async () => {
		const pages = Array.from({ length: FIND_INVOICE_MAX_PAGES + 1 }, (_, i) => ({ object: 'list', has_more: true, data: [{ id: `in_P${i}`, status: 'paid', metadata: {} }] }));
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const a = scripted({ 'GET /v1/invoices': pages });
		await expect(createInvoice({ secretKey: KEY, fetch: a.f }, params)).rejects.toMatchObject({ status: 502, code: 'invoice_pages' });
		expect(a.calls).toHaveLength(FIND_INVOICE_MAX_PAGES);
		expect(a.calls.every((c) => c.method === 'GET')).toBe(true);
		expect(err).toHaveBeenCalledWith(expect.stringContaining('stripe_invoice_lookup_too_many'));
		err.mockRestore();
		const b = scripted({ 'GET /v1/invoices': [{ object: 'list', has_more: true, data: [] }] });
		await expect(createInvoice({ secretKey: KEY, fetch: b.f }, params)).rejects.toMatchObject({ code: 'data' });
		expect(b.calls).toHaveLength(1);
	});

	it('completes a draft this key left with its lines already on it: finalizes and sends without adding lines again', async () => {
		const { f, calls } = scripted({
			'GET /v1/invoices': [{ object: 'list', data: [{ ...draft, total: 3497000 }] }],
			'POST /v1/invoices/in_New1/finalize': [open],
			'POST /v1/invoices/in_New1/send': [open],
			'POST /v1/invoices/in_New1': [open]
		});
		expect(await createInvoice({ secretKey: KEY, fetch: f }, params)).toMatchObject({ invoiceId: 'in_New1', reused: false });
		expect(calls.some((c) => c.url.includes('invoiceitems'))).toBe(false);
	});

	it('makes a new one when the key’s earlier invoice was voided, and refuses a draft whose total isn’t ours', async () => {
		const voided = { ...open, id: 'in_Void', status: 'void' };
		const a = scripted({ 'GET /v1/invoices': [{ data: [voided] }], 'POST /v1/invoices': [] });
		await expect(createInvoice({ secretKey: KEY, fetch: a.f }, params)).rejects.toBeInstanceOf(StripeApiError);
		expect(a.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
		const b = scripted({ 'GET /v1/invoices': [{ data: [{ ...draft, total: 1 }] }] });
		await expect(createInvoice({ secretKey: KEY, fetch: b.f }, params)).rejects.toMatchObject({ code: 'total' });
	});

	it('refuses a malformed customer or an empty or non-positive line before any request', async () => {
		const { f, calls } = scripted({});
		await expect(createInvoice({ secretKey: KEY, fetch: f }, { ...params, customer: 'cus_x/../y' })).rejects.toMatchObject({ code: 'customer' });
		await expect(createInvoice({ secretKey: KEY, fetch: f }, { ...params, lines: [] })).rejects.toMatchObject({ code: 'lines' });
		await expect(createInvoice({ secretKey: KEY, fetch: f }, { ...params, lines: [{ amountMinor: 0, description: 'x' }] })).rejects.toMatchObject({ code: 'lines' });
		expect(calls).toHaveLength(0);
	});
});

describe('listOpenSubscriptions and cancelSubscription (deleting an account)', () => {
	it('lists the customer’s subscriptions in the query, leaving out the ended ones', async () => {
		const { f, calls } = fakeFetch(200, {
			object: 'list',
			has_more: false,
			data: [
				{ id: 'sub_Open1', status: 'active' },
				{ id: 'sub_Open2', status: 'past_due' },
				{ id: 'sub_Gone', status: 'incomplete_expired' },
				{ id: 'sub_Done', status: 'canceled' }
			]
		});
		expect(await listOpenSubscriptions({ secretKey: KEY, fetch: f }, 'cus_Test123')).toEqual(['sub_Open1', 'sub_Open2']);
		expect(calls[0]!.init.method).toBe('GET');
		expect(calls[0]!.url).toBe('https://api.stripe.com/v1/subscriptions?customer=cus_Test123&limit=100');
		expect(headers(calls[0]!.init)['Stripe-Version']).toBe(STRIPE_API_VERSION);
	});

	it('refuses a list with more pages, a malformed answer and a bad customer id, rather than cancel some', async () => {
		await expect(listOpenSubscriptions({ secretKey: KEY, fetch: fakeFetch(200, { data: [], has_more: true }).f }, 'cus_Test123')).rejects.toBeInstanceOf(StripeApiError);
		await expect(listOpenSubscriptions({ secretKey: KEY, fetch: fakeFetch(200, { data: [{ id: 'nope', status: 'active' }] }).f }, 'cus_Test123')).rejects.toBeInstanceOf(StripeApiError);
		const { f, calls } = fakeFetch(200, { data: [] });
		await expect(listOpenSubscriptions({ secretKey: KEY, fetch: f }, 'cus_../x')).rejects.toBeInstanceOf(StripeApiError);
		expect(calls).toEqual([]);
	});

	it('cancels now with invoice_now and prorate false, and checks the answer says canceled', async () => {
		const { f, calls } = fakeFetch(200, { id: 'sub_Open1', status: 'canceled' });
		await cancelSubscription({ secretKey: KEY, fetch: f }, 'sub_Open1');
		expect(calls[0]!.init.method).toBe('DELETE');
		expect(calls[0]!.url).toBe('https://api.stripe.com/v1/subscriptions/sub_Open1?invoice_now=false&prorate=false');
		await expect(cancelSubscription({ secretKey: KEY, fetch: fakeFetch(200, { id: 'sub_Open1', status: 'active' }).f }, 'sub_Open1')).rejects.toBeInstanceOf(StripeApiError);
	});

	it('takes a subscription Stripe no longer has as cancelled, and throws any other failure', async () => {
		await expect(
			cancelSubscription({ secretKey: KEY, fetch: fakeFetch(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } }).f }, 'sub_Gone')
		).resolves.toBeUndefined();
		await expect(cancelSubscription({ secretKey: KEY, fetch: fakeFetch(500, { error: { type: 'api_error' } }).f }, 'sub_Open1')).rejects.toBeInstanceOf(StripeApiError);
		const { f, calls } = fakeFetch(200, {});
		await expect(cancelSubscription({ secretKey: KEY, fetch: f }, 'sub_mock_1/../x')).rejects.toBeInstanceOf(StripeApiError);
		expect(calls).toEqual([]);
	});
});

describe('listOpenCheckoutSessions and expireCheckoutSession (deleting an account)', () => {
	it('lists the customer’s open Checkout sessions in the query', async () => {
		const { f, calls } = fakeFetch(200, { object: 'list', has_more: false, data: [{ id: 'cs_test_Open1', status: 'open' }, { id: 'cs_live_Open2', status: 'open' }] });
		expect(await listOpenCheckoutSessions({ secretKey: KEY, fetch: f }, 'cus_Test123')).toEqual(['cs_test_Open1', 'cs_live_Open2']);
		expect(calls[0]!.init.method).toBe('GET');
		expect(calls[0]!.url).toBe('https://api.stripe.com/v1/checkout/sessions?customer=cus_Test123&status=open&limit=100');
		expect(headers(calls[0]!.init)['Stripe-Version']).toBe(STRIPE_API_VERSION);
	});

	it('refuses a list with more pages, a malformed id and a bad customer id, rather than expire some', async () => {
		await expect(listOpenCheckoutSessions({ secretKey: KEY, fetch: fakeFetch(200, { data: [], has_more: true }).f }, 'cus_Test123')).rejects.toBeInstanceOf(StripeApiError);
		await expect(listOpenCheckoutSessions({ secretKey: KEY, fetch: fakeFetch(200, { data: [{ id: 'cs_../x' }] }).f }, 'cus_Test123')).rejects.toBeInstanceOf(StripeApiError);
		const { f, calls } = fakeFetch(200, { data: [] });
		await expect(listOpenCheckoutSessions({ secretKey: KEY, fetch: f }, 'cus_../x')).rejects.toBeInstanceOf(StripeApiError);
		expect(calls).toEqual([]);
	});

	it('expires a session with a POST and checks the answer says expired', async () => {
		const { f, calls } = fakeFetch(200, { id: 'cs_test_Open1', status: 'expired' });
		await expireCheckoutSession({ secretKey: KEY, fetch: f }, 'cs_test_Open1');
		expect(calls[0]!.init.method).toBe('POST');
		expect(calls[0]!.url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_Open1/expire');
		await expect(expireCheckoutSession({ secretKey: KEY, fetch: fakeFetch(200, { id: 'cs_test_Open1', status: 'open' }).f }, 'cs_test_Open1')).rejects.toBeInstanceOf(StripeApiError);
	});

	it('takes a session no longer open (completed or expired meanwhile) or missing as done, and throws any other failure', async () => {
		await expect(expireCheckoutSession({ secretKey: KEY, fetch: fakeFetch(400, { error: { type: 'invalid_request_error' } }).f }, 'cs_test_Done')).resolves.toBeUndefined();
		await expect(
			expireCheckoutSession({ secretKey: KEY, fetch: fakeFetch(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } }).f }, 'cs_test_Gone')
		).resolves.toBeUndefined();
		await expect(expireCheckoutSession({ secretKey: KEY, fetch: fakeFetch(401, { error: { type: 'invalid_request_error' } }).f }, 'cs_test_Open1')).rejects.toBeInstanceOf(StripeApiError);
		await expect(expireCheckoutSession({ secretKey: KEY, fetch: fakeFetch(500, { error: { type: 'api_error' } }).f }, 'cs_test_Open1')).rejects.toBeInstanceOf(StripeApiError);
		const { f, calls } = fakeFetch(200, {});
		await expect(expireCheckoutSession({ secretKey: KEY, fetch: f }, 'cs_test/../x')).rejects.toBeInstanceOf(StripeApiError);
		expect(calls).toEqual([]);
	});
});

/** A fetch that answers each request by its method and path (no query), recording every call; a route missing is a test bug. */
function routedFetch(routes: Record<string, (init: RequestInit, url: URL) => { status: number; body: unknown }>) {
	const calls: { method: string; url: string; init: RequestInit }[] = [];
	const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const key = `${init!.method} ${url.pathname}`;
		calls.push({ method: init!.method!, url: String(input), init: init! });
		const route = routes[key];
		if (!route) throw new Error(`no fake route for ${key}`);
		const { status, body } = route(init!, url);
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	});
	return { f: f as unknown as typeof fetch, calls };
}
/** "Now" for the orphan tests, in ms; the refund window runs back ORPHAN_REFUND_WINDOW_SECONDS from it. */
const NOW_MS = Date.UTC(2026, 10, 24, 12);
const NOW_S = NOW_MS / 1000;
const WINDOW_START = NOW_S - ORPHAN_REFUND_WINDOW_SECONDS;
/** A paid invoice of the subscription: its first (subscription_create) unless `reason` says otherwise, paid `agoS` seconds before NOW. */
const invoice = (id: string, agoS: number, reason = 'subscription_create', amountPaid = 4900) => ({
	id,
	amount_paid: amountPaid,
	status: 'paid',
	billing_reason: reason,
	created: NOW_S - agoS - 5,
	status_transitions: { paid_at: NOW_S - agoS }
});
const invoices = (...data: unknown[]) => ({ status: 200, body: { object: 'list', has_more: false, data } });
const paidInvoice = invoices(invoice('in_Paid1', 60));
const paidPayment = { status: 200, body: { object: 'list', has_more: false, data: [{ id: 'inpay_1', status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_Paid1' } }] } };
const run = (f: typeof fetch, sub = 'sub_Orphan1') => orphanCancelAndRefund({ secretKey: KEY, fetch: f }, sub, ACCOUNT, NOW_MS);

describe('orphanCancelAndRefund (a subscription whose account is gone)', () => {
	it('reads the subscription, lists its recent paid invoices, cancels it now, and refunds the first invoice’s payments whole under a key per payment', async () => {
		const { f, calls } = routedFetch({
			'GET /v1/subscriptions/sub_Orphan1': () => ({ status: 200, body: { id: 'sub_Orphan1', status: 'active' } }),
			'DELETE /v1/subscriptions/sub_Orphan1': () => ({ status: 200, body: { id: 'sub_Orphan1', status: 'canceled' } }),
			'GET /v1/invoices': () => paidInvoice,
			'GET /v1/invoice_payments': () => paidPayment,
			'POST /v1/refunds': () => ({ status: 200, body: { id: 're_1', object: 'refund', amount: 4900, status: 'succeeded' } })
		});
		expect(await run(f)).toEqual({ cancelled: true, refunds: 1, refundedMinor: 4900, skipped: false });
		expect(calls.map((c) => c.method + ' ' + c.url)).toEqual([
			'GET https://api.stripe.com/v1/subscriptions/sub_Orphan1',
			`GET https://api.stripe.com/v1/invoices?subscription=sub_Orphan1&status=paid&created%5Bgte%5D=${WINDOW_START}&limit=100`,
			'DELETE https://api.stripe.com/v1/subscriptions/sub_Orphan1?invoice_now=false&prorate=false',
			'GET https://api.stripe.com/v1/invoice_payments?invoice=in_Paid1&status=paid&limit=100',
			'POST https://api.stripe.com/v1/refunds'
		]);
		const refund = calls[4]!.init;
		expect(form(refund)).toEqual({
			payment_intent: 'pi_Paid1',
			reason: 'requested_by_customer',
			'metadata[wm_reason]': 'account_deleted',
			'metadata[billing_account_id]': ACCOUNT
		});
		expect(headers(refund)).toMatchObject({ 'Idempotency-Key': 'wm-orphan-refund-pi_Paid1', 'Stripe-Version': STRIPE_API_VERSION });
		// Nothing that could name the person is sent.
		expect(String(refund.body)).not.toMatch(/@|email/);
	});

	it('refunds only the create invoice: never a renewal, an update’s proration or any other paid invoice', async () => {
		const { f, calls } = routedFetch({
			'GET /v1/subscriptions/sub_Orphan1': () => ({ status: 200, body: { status: 'active' } }),
			'DELETE /v1/subscriptions/sub_Orphan1': () => ({ status: 200, body: { status: 'canceled' } }),
			'GET /v1/invoices': () => invoices(invoice('in_Cycle1', 30, 'subscription_cycle'), invoice('in_Update1', 40, 'subscription_update', 1200), invoice('in_First1', 50)),
			'GET /v1/invoice_payments': () => paidPayment,
			'POST /v1/refunds': () => ({ status: 200, body: { amount: 4900, status: 'succeeded' } })
		});
		expect(await run(f)).toEqual({ cancelled: true, refunds: 1, refundedMinor: 4900, skipped: false });
		const listed = calls.filter((c) => c.url.includes('/v1/invoice_payments'));
		expect(listed.map((c) => new URL(c.url).searchParams.get('invoice'))).toEqual(['in_First1']);
		expect(calls.filter((c) => c.url.endsWith('/v1/refunds'))).toHaveLength(1);
	});

	it('leaves an ended subscription whose first invoice is older than the window alone: no cancel, no refund, skipped (a late event about one its account used)', async () => {
		// Positive control first: the same ended subscription with its first invoice inside the window is refunded.
		const recent = routedFetch({
			'GET /v1/subscriptions/sub_Orphan1': () => ({ status: 200, body: { status: 'canceled' } }),
			'GET /v1/invoices': () => invoices(invoice('in_First1', ORPHAN_REFUND_WINDOW_SECONDS - 60)),
			'GET /v1/invoice_payments': () => paidPayment,
			'POST /v1/refunds': () => ({ status: 200, body: { amount: 4900, status: 'succeeded' } })
		});
		expect(await run(recent.f)).toEqual({ cancelled: false, refunds: 1, refundedMinor: 4900, skipped: false });
		for (const old of [
			invoices(), // Stripe's created[gte] filter left the old first invoice out
			invoices(invoice('in_Cycle9', 3600, 'subscription_cycle')), // only a recent renewal: never refunded
			invoices(invoice('in_First1', ORPHAN_REFUND_WINDOW_SECONDS + 60)) // created inside, but paid before the window
		]) {
			const { f, calls } = routedFetch({
				'GET /v1/subscriptions/sub_Orphan1': () => ({ status: 200, body: { status: 'canceled' } }),
				'GET /v1/invoices': () => old
			});
			expect(await run(f)).toEqual({ cancelled: false, refunds: 0, refundedMinor: 0, skipped: true });
			expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
		}
		// One Stripe no longer has, with an old first invoice: skipped too.
		const gone = routedFetch({
			'GET /v1/subscriptions/sub_Gone1': () => ({ status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing' } } }),
			'GET /v1/invoices': () => invoices()
		});
		expect(await run(gone.f, 'sub_Gone1')).toEqual({ cancelled: false, refunds: 0, refundedMinor: 0, skipped: true });
	});

	it('cancels a live one whose first invoice is older than the window (nothing should charge again) but refunds nothing', async () => {
		const { f, calls } = routedFetch({
			'GET /v1/subscriptions/sub_Orphan1': () => ({ status: 200, body: { status: 'active' } }),
			'DELETE /v1/subscriptions/sub_Orphan1': () => ({ status: 200, body: { status: 'canceled' } }),
			'GET /v1/invoices': () => invoices()
		});
		expect(await run(f)).toEqual({ cancelled: true, refunds: 0, refundedMinor: 0, skipped: false });
		expect(calls.some((c) => c.url.includes('/v1/refunds') || c.url.includes('/v1/invoice_payments'))).toBe(false);
	});

	it('a retry after a cancel whose refund failed refunds once: the ended subscription’s recent first invoice, under the same key', async () => {
		let refundAttempts = 0;
		let live = true;
		const routes = {
			'GET /v1/subscriptions/sub_Orphan1': () => ({ status: 200, body: { status: live ? 'active' : 'canceled' } }),
			'DELETE /v1/subscriptions/sub_Orphan1': () => {
				live = false;
				return { status: 200, body: { status: 'canceled' } };
			},
			'GET /v1/invoices': () => paidInvoice,
			'GET /v1/invoice_payments': () => paidPayment,
			'POST /v1/refunds': () => {
				refundAttempts += 1;
				return refundAttempts === 1 ? { status: 500, body: { error: { type: 'api_error' } } } : { status: 200, body: { amount: 4900, status: 'succeeded' } };
			}
		};
		const first = routedFetch(routes);
		await expect(run(first.f)).rejects.toMatchObject({ status: 500, step: 'refund' });
		const retry = routedFetch(routes);
		expect(await run(retry.f)).toEqual({ cancelled: false, refunds: 1, refundedMinor: 4900, skipped: false });
		expect(retry.calls.some((c) => c.method === 'DELETE')).toBe(false);
		const keys = [...first.calls, ...retry.calls].filter((c) => c.url.endsWith('/v1/refunds')).map((c) => headers(c.init)['Idempotency-Key']);
		expect(keys).toEqual(['wm-orphan-refund-pi_Paid1', 'wm-orphan-refund-pi_Paid1']);
		// A third delivery: Stripe says it's refunded already, so nothing more is refunded.
		const third = routedFetch({ ...routes, 'POST /v1/refunds': () => ({ status: 400, body: { error: { type: 'invalid_request_error', code: 'charge_already_refunded' } } }) });
		expect(await run(third.f)).toEqual({ cancelled: false, refunds: 0, refundedMinor: 0, skipped: false });
	});

	it('refunds a charge payment by its charge', async () => {
		const { f, calls } = routedFetch({
			'GET /v1/subscriptions/sub_Orphan1': () => ({ status: 200, body: { id: 'sub_Orphan1', status: 'canceled' } }),
			'GET /v1/invoices': () => paidInvoice,
			'GET /v1/invoice_payments': () => ({ status: 200, body: { data: [{ status: 'paid', payment: { type: 'charge', charge: 'ch_Paid1' } }] } }),
			'POST /v1/refunds': () => ({ status: 200, body: { id: 're_1', amount: 4900, status: 'pending' } })
		});
		expect(await run(f)).toEqual({ cancelled: false, refunds: 1, refundedMinor: 4900, skipped: false });
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
		expect(form(calls.at(-1)!.init).charge).toBe('ch_Paid1');
		expect(headers(calls.at(-1)!.init)['Idempotency-Key']).toBe('wm-orphan-refund-ch_Paid1');
	});

	it('takes a payment refunded already or charged back as done, and a trial (nothing paid) as cancelled only', async () => {
		for (const code of ['charge_already_refunded', 'charge_disputed', 'refund_disputed_payment']) {
			const { f } = routedFetch({
				'GET /v1/subscriptions/sub_Orphan1': () => ({ status: 200, body: { status: 'canceled' } }),
				'GET /v1/invoices': () => paidInvoice,
				'GET /v1/invoice_payments': () => paidPayment,
				'POST /v1/refunds': () => ({ status: 400, body: { error: { type: 'invalid_request_error', code } } })
			});
			expect(await run(f)).toEqual({ cancelled: false, refunds: 0, refundedMinor: 0, skipped: false });
		}
		const { f, calls } = routedFetch({
			'GET /v1/subscriptions/sub_Trial1': () => ({ status: 200, body: { status: 'trialing' } }),
			'DELETE /v1/subscriptions/sub_Trial1': () => ({ status: 200, body: { status: 'canceled' } }),
			'GET /v1/invoices': () => invoices(invoice('in_Zero1', 60, 'subscription_create', 0))
		});
		expect(await run(f, 'sub_Trial1')).toEqual({ cancelled: true, refunds: 0, refundedMinor: 0, skipped: false });
		expect(calls.some((c) => c.url.includes('/v1/refunds'))).toBe(false);
	});

	it('throws on any other failure (so the webhook answers non-2xx), tagged with its step, on a malformed answer, more pages, or a bad id, never calling with one', async () => {
		const base = {
			'GET /v1/subscriptions/sub_Orphan1': () => ({ status: 200, body: { status: 'active' } }),
			'DELETE /v1/subscriptions/sub_Orphan1': () => ({ status: 200, body: { status: 'canceled' } }),
			'GET /v1/invoices': () => paidInvoice,
			'GET /v1/invoice_payments': () => paidPayment,
			'POST /v1/refunds': () => ({ status: 200, body: { amount: 4900, status: 'succeeded' } })
		};
		const failing: [string, Record<string, () => { status: number; body: unknown }>][] = [
			['cancel', { 'DELETE /v1/subscriptions/sub_Orphan1': () => ({ status: 500, body: { error: { type: 'api_error' } } }) }],
			['refund', { 'POST /v1/refunds': () => ({ status: 402, body: { error: { type: 'card_error', code: 'balance_insufficient' } } }) }],
			['refund', { 'POST /v1/refunds': () => ({ status: 200, body: { status: 'failed' } }) }],
			['list', { 'GET /v1/invoices': () => ({ status: 200, body: { data: [], has_more: true } }) }],
			['refund', { 'GET /v1/invoice_payments': () => ({ status: 200, body: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_../x' } }] } }) }],
			['refund', { 'GET /v1/invoice_payments': () => ({ status: 200, body: { data: [{ payment: { type: 'out_of_band_payment' } }] } }) }],
			['payments', { 'GET /v1/invoice_payments': () => ({ status: 503, body: { error: { type: 'api_error' } } }) }],
			['read', { 'GET /v1/subscriptions/sub_Orphan1': () => ({ status: 401, body: { error: { type: 'invalid_request_error' } } }) }]
		];
		for (const [step, over] of failing) {
			const e = await run(routedFetch({ ...base, ...over }).f).catch((x: unknown) => x);
			expect(e, step).toBeInstanceOf(StripeApiError);
			expect((e as { step?: string }).step, JSON.stringify(Object.keys(over))).toBe(step);
		}
		const { f, calls } = routedFetch(base);
		await expect(run(f, 'sub_../x')).rejects.toBeInstanceOf(StripeApiError);
		expect(calls).toEqual([]);
	});
});
