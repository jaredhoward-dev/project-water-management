// The provider choice (provider.ts): mock by default, manual takes no webhooks,
// stripe and mock check the signature, and a name that isn't ours is no
// provider at all (never the mock).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { billingProvider, billingProviderName, checkoutPrices, type CheckoutPlan, type ReturnUrls } from './provider.js';
import { readMockSession } from './provider/mock.js';
import { signPayload } from './provider/signature.js';

const SECRET = 'test-only-billing-secret-0000000000000000';
const BODY = readFileSync(new URL('../../fixtures/billing/subscription-updated.json', import.meta.url), 'utf8');
const NOW = 1_800_000_000_000;
const signed = (body = BODY, secret = SECRET) => ({ 'stripe-signature': signPayload(secret, body, NOW / 1000) });

describe('billingProviderName', () => {
	it('is the mock when unset or blank (the code default), else the name given', () => {
		expect(billingProviderName({})).toBe('mock');
		expect(billingProviderName({ BILLING_PROVIDER: ' ' })).toBe('mock');
		for (const n of ['mock', 'manual', 'stripe'] as const) expect(billingProviderName({ BILLING_PROVIDER: n })).toBe(n);
	});

	it('is null for a name that isn’t ours, never a fallback to the mock', () => {
		for (const n of ['stripe_billing', 'Stripe', 'paystack']) {
			expect(billingProviderName({ BILLING_PROVIDER: n }), n).toBeNull();
			expect(billingProvider({ BILLING_PROVIDER: n }), n).toBeNull();
		}
	});
});

describe('verifyAndNormalise', () => {
	it('stripe and mock accept a signed event and normalise it (positive control)', () => {
		for (const name of ['stripe', 'mock']) {
			const p = billingProvider({ BILLING_PROVIDER: name, BILLING_WEBHOOK_SECRET: SECRET })!;
			expect(p.acceptsWebhooks).toBe(true);
			expect(p.verifyAndNormalise(BODY, signed(), NOW), name).toMatchObject({ ok: true, event: { type: 'subscription.updated' } });
		}
	});

	it('refuses a bad signature, and any signature when no secret is set', () => {
		const p = billingProvider({ BILLING_PROVIDER: 'stripe', BILLING_WEBHOOK_SECRET: SECRET })!;
		expect(p.verifyAndNormalise(BODY, signed(BODY, 'another-secret'), NOW)).toEqual({ ok: false, reason: 'signature' });
		expect(p.verifyAndNormalise(BODY, {}, NOW)).toEqual({ ok: false, reason: 'signature' });
		const unset = billingProvider({ BILLING_PROVIDER: 'stripe' })!;
		expect(unset.verifyAndNormalise(BODY, signed(BODY, ''), NOW)).toEqual({ ok: false, reason: 'signature' });
	});

	it('refuses a signed body that isn’t JSON or isn’t an event it can read', () => {
		const p = billingProvider({ BILLING_PROVIDER: 'mock', BILLING_WEBHOOK_SECRET: SECRET })!;
		expect(p.verifyAndNormalise('not json', signed('not json'), NOW)).toEqual({ ok: false, reason: 'invalid' });
		expect(p.verifyAndNormalise('{"id":"evt_1"}', signed('{"id":"evt_1"}'), NOW)).toEqual({ ok: false, reason: 'invalid' });
	});

	it('answers a signed event of a type it doesn’t act on as ignored', () => {
		const body = '{"id":"evt_1","type":"customer.created","data":{"object":{}}}';
		const p = billingProvider({ BILLING_PROVIDER: 'mock', BILLING_WEBHOOK_SECRET: SECRET })!;
		expect(p.verifyAndNormalise(body, signed(body), NOW)).toEqual({ ok: true, ignored: { eventId: 'evt_1', type: 'customer.created' } });
	});

	it('manual takes no webhooks', () => {
		const p = billingProvider({ BILLING_PROVIDER: 'manual', BILLING_WEBHOOK_SECRET: SECRET })!;
		expect(p.acceptsWebhooks).toBe(false);
		expect(p.verifyAndNormalise(BODY, signed(), NOW).ok).toBe(false);
	});
});

describe('checkout and the portal (Phase 3)', () => {
	const ACCOUNT = '22222222-2222-4222-8222-222222222222';
	const PRO: CheckoutPlan = { code: 'pro', name: 'Pro', priceMonthlyMinor: 89900, priceAnnualMinor: 899000, currency: 'ZAR', seatsIncluded: 1, extraSeatMonthlyMinor: null, extraSeatAnnualMinor: null };
	const TEAM: CheckoutPlan = { code: 'team', name: 'Team', priceMonthlyMinor: 249900, priceAnnualMinor: 2499000, currency: 'ZAR', seatsIncluded: 3, extraSeatMonthlyMinor: 49900, extraSeatAnnualMinor: 499000 };

	it('checkoutPrices: the base, plus each seat past the included ones at the interval’s extra-seat price', () => {
		expect(checkoutPrices(TEAM, 'month', 5)).toEqual({ baseMinor: 249900, extraSeats: 2, extraSeatMinor: 49900, totalMinor: 349700 });
		expect(checkoutPrices(TEAM, 'year', 3)).toEqual({ baseMinor: 2499000, extraSeats: 0, extraSeatMinor: 499000, totalMinor: 2499000 });
		expect(checkoutPrices(PRO, 'month', 1)).toEqual({ baseMinor: 89900, extraSeats: 0, extraSeatMinor: 0, totalMinor: 89900 });
	});

	it('mock signs Team’s seats into its token: the whole price, the seats and the included ones', async () => {
		const p = billingProvider({ BILLING_WEBHOOK_SECRET: SECRET }, { now: () => NOW })!;
		const { url } = await p.createCheckout({ id: ACCOUNT, customerRef: null }, TEAM, 'month', URLS, 5);
		expect(readMockSession(SECRET, new URL(url).searchParams.get('t'), NOW)).toMatchObject({ planCode: 'team', amountMinor: 349700, seats: 5, seatsIncluded: 3, extraSeatMinor: 49900 });
	});

	it('stripe sends Team’s extra seats as a second line item', async () => {
		const f = vi.fn(async () => new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/t' }), { status: 200 }));
		const p = billingProvider({ BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: KEY }, { fetch: f as unknown as typeof fetch })!;
		await p.createCheckout({ id: ACCOUNT, customerRef: 'cus_Old1' }, TEAM, 'month', URLS, 5);
		const body = new URLSearchParams(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
		expect([body.get('line_items[0][quantity]'), body.get('line_items[0][price_data][unit_amount]')]).toEqual(['1', '249900']);
		expect([body.get('line_items[1][quantity]'), body.get('line_items[1][price_data][unit_amount]')]).toEqual(['2', '49900']);
		expect(body.get('subscription_data[metadata][seats_included]')).toBe('3');
	});
	const URLS: ReturnUrls = { successUrl: 'http://localhost:7777/account/plan?checkout=done', cancelUrl: 'http://localhost:7777/account/plan?checkout=cancelled', apiBase: 'http://localhost:3001' };
	const KEY = 'test-only-not-a-stripe-key';
	const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: string; status?: number }) => `${e.status} ${e.code}`);

	it('manual refuses both with billing_unavailable (409)', async () => {
		const p = billingProvider({ BILLING_PROVIDER: 'manual' })!;
		expect(await code(p.createCheckout({ id: ACCOUNT, customerRef: null }, PRO, 'month', URLS))).toBe('409 billing_unavailable');
		expect(await code(p.createPortal({ id: ACCOUNT, customerRef: null }, null, URLS))).toBe('409 billing_unavailable');
	});

	it('mock answers its own page on this API, with a token for the account, plan, interval and price', async () => {
		const p = billingProvider({ BILLING_WEBHOOK_SECRET: SECRET }, { now: () => NOW })!;
		const { url, newCustomerRef } = await p.createCheckout({ id: ACCOUNT, customerRef: null }, PRO, 'year', URLS);
		expect(newCustomerRef).toBeUndefined();
		const u = new URL(url);
		expect(`${u.origin}${u.pathname}`).toBe('http://localhost:3001/billing/mock/checkout');
		expect(readMockSession(SECRET, u.searchParams.get('t'), NOW)).toMatchObject({ kind: 'checkout', accountId: ACCOUNT, planCode: 'pro', interval: 'year', amountMinor: 899000, successUrl: URLS.successUrl });
		const portal = new URL((await p.createPortal({ id: ACCOUNT, customerRef: null }, null, URLS)).url);
		expect(portal.pathname).toBe('/billing/mock/portal');
		expect(readMockSession(SECRET, portal.searchParams.get('t'), NOW)).toMatchObject({ kind: 'portal', accountId: ACCOUNT, subscription: null });
	});

	it('mock signs the plan figures at the subscription’s interval into its portal token, never the plan itself (#928)', async () => {
		const p = billingProvider({ BILLING_WEBHOOK_SECRET: SECRET }, { now: () => NOW })!;
		const live = { planCode: 'team', status: 'active', periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2027-11-01T00:00:00.000Z', cancelAtPeriodEnd: false, seats: 5, seatsIncluded: 3 };
		const token = async (sub: Parameters<typeof p.createPortal>[1]) => readMockSession(SECRET, new URL((await p.createPortal({ id: ACCOUNT, customerRef: null }, sub, URLS)).url).searchParams.get('t'), NOW);
		const yearly = await token({ ...live, interval: 'year', plan: TEAM });
		expect(yearly).toMatchObject({ subscription: { baseMinor: 2499000, extraSeatMinor: 499000, currency: 'ZAR', interval: 'year' } });
		expect(yearly?.kind === 'portal' && yearly.subscription && 'plan' in yearly.subscription).toBe(false);
		// No interval recorded, or the plan not on sale: no figures, so the cancel's items carry no price (mock.ts MockPricing).
		for (const sub of [{ ...live, interval: null, plan: TEAM }, { ...live, interval: 'year' as const }]) {
			const t = await token(sub);
			expect(t?.kind === 'portal' && t.subscription && 'baseMinor' in t.subscription).toBe(false);
		}
	});

	it('mock without its dev key is billing_provider_error, never an unsigned page', async () => {
		const p = billingProvider({})!;
		expect(await code(p.createCheckout({ id: ACCOUNT, customerRef: null }, PRO, 'month', URLS))).toBe('503 billing_provider_error');
	});

	it('stripe makes the customer once, then the session for it, and hands the new customer back to store', async () => {
		const answers = [
			{ id: 'cus_New1', object: 'customer' },
			{ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }
		];
		const f = vi.fn(async () => new Response(JSON.stringify(answers.shift()), { status: 200 }));
		const p = billingProvider({ BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: KEY }, { fetch: f as unknown as typeof fetch })!;
		expect(await p.createCheckout({ id: ACCOUNT, customerRef: null }, PRO, 'month', URLS)).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1', newCustomerRef: 'cus_New1' });
		expect(f.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual(['https://api.stripe.com/v1/customers', 'https://api.stripe.com/v1/checkout/sessions']);
	});

	it('stripe reuses a stored customer, and opens the portal for it', async () => {
		const f = vi.fn(async (url: string) =>
			new Response(JSON.stringify(url.endsWith('/checkout/sessions') ? { url: 'https://checkout.stripe.com/c/pay/x' } : { url: 'https://billing.stripe.com/p/session/x' }), { status: 200 })
		);
		const p = billingProvider({ BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: KEY }, { fetch: f as unknown as typeof fetch })!;
		expect(await p.createCheckout({ id: ACCOUNT, customerRef: 'cus_Old1' }, PRO, 'month', URLS)).toEqual({ url: 'https://checkout.stripe.com/c/pay/x' });
		expect(await p.createPortal({ id: ACCOUNT, customerRef: 'cus_Old1' }, null, URLS)).toEqual({ url: 'https://billing.stripe.com/p/session/x' });
		expect(f.mock.calls.map((c) => String(c[0]))).toEqual(['https://api.stripe.com/v1/checkout/sessions', 'https://api.stripe.com/v1/billing_portal/sessions']);
	});

	it('stripe: no customer is billing_no_customer; no key, an error answer or a network failure is billing_provider_error', async () => {
		const ok = vi.fn();
		const p = billingProvider({ BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: KEY }, { fetch: ok as unknown as typeof fetch })!;
		expect(await code(p.createPortal({ id: ACCOUNT, customerRef: null }, null, URLS))).toBe('409 billing_no_customer');
		expect(ok).not.toHaveBeenCalled();
		expect(await code(billingProvider({ BILLING_PROVIDER: 'stripe' })!.createCheckout({ id: ACCOUNT, customerRef: 'cus_1' }, PRO, 'month', URLS))).toBe(
			'503 billing_provider_error'
		);
		const failing = vi.fn(async () => new Response(JSON.stringify({ error: { type: 'api_error' } }), { status: 500 }));
		const down = vi.fn(async () => {
			throw new TypeError('fetch failed');
		});
		for (const f of [failing, down]) {
			const q = billingProvider({ BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: KEY }, { fetch: f as unknown as typeof fetch })!;
			expect(await code(q.createCheckout({ id: ACCOUNT, customerRef: 'cus_1' }, PRO, 'month', URLS))).toBe('503 billing_provider_error');
		}
	});
});

describe('cancelSubscriptions (deleting an account)', () => {
	const ACCT = '44444444-4444-4444-8444-444444444444';
	/** A Stripe that lists `open` subscriptions and `sessions` open Checkout sessions for the customer, and answers every cancel and expiry as done. */
	function stripeWith(open: string[], sessions: string[] = []) {
		const calls: { method: string; url: string }[] = [];
		const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ method: String(init?.method), url: String(url) });
			const path = new URL(String(url)).pathname;
			const list = (ids: string[], status: string) => ({ object: 'list', has_more: false, data: ids.map((id) => ({ id, status })) });
			const body =
				init?.method === 'GET'
					? path === '/v1/checkout/sessions'
						? list(sessions, 'open')
						: list(open, 'active')
					: path.endsWith('/expire')
						? { status: 'expired' }
						: { status: 'canceled' };
			return new Response(JSON.stringify(body), { status: 200 });
		});
		const p = billingProvider({ BILLING_PROVIDER: 'stripe', BILLING_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: 'test-only-key' }, { fetch: f as unknown as typeof fetch })!;
		return { p, calls };
	}

	it('stripe cancels every open subscription of the customer, one we never recorded included, and answers the recorded ones as settled', async () => {
		const { p, calls } = stripeWith(['sub_Rec1', 'sub_Unrec']);
		const out = await p.cancelSubscriptions({ accountId: ACCT, customerRef: 'cus_Del1', subscriptionRefs: ['sub_Rec1', 'sub_EndedAlready'] });
		expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			'GET /v1/checkout/sessions',
			'GET /v1/subscriptions',
			'DELETE /v1/subscriptions/sub_Rec1',
			'DELETE /v1/subscriptions/sub_Unrec'
		]);
		expect(out.sort()).toEqual(['sub_EndedAlready', 'sub_Rec1', 'sub_Unrec']);
	});

	it('stripe expires the customer’s open Checkout sessions before it lists the subscriptions', async () => {
		const { p, calls } = stripeWith(['sub_Rec3'], ['cs_test_Open1', 'cs_test_Open2']);
		expect(await p.cancelSubscriptions({ accountId: ACCT, customerRef: 'cus_Del3', subscriptionRefs: ['sub_Rec3'] })).toEqual(['sub_Rec3']);
		expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			'GET /v1/checkout/sessions',
			'POST /v1/checkout/sessions/cs_test_Open1/expire',
			'POST /v1/checkout/sessions/cs_test_Open2/expire',
			'GET /v1/subscriptions',
			'DELETE /v1/subscriptions/sub_Rec3'
		]);
		expect(new URL(calls[0]!.url).searchParams.get('status')).toBe('open');
	});

	it('stripe with no customer stored cancels the recorded ones by id', async () => {
		const { p, calls } = stripeWith([]);
		expect(await p.cancelSubscriptions({ accountId: ACCT, customerRef: null, subscriptionRefs: ['sub_Rec2'] })).toEqual(['sub_Rec2']);
		expect(calls.map((c) => c.method)).toEqual(['DELETE']);
	});

	it('stripe answers a failure as the coded 503 and no key as the same, before any call', async () => {
		const failing = billingProvider(
			{ BILLING_PROVIDER: 'stripe', BILLING_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: 'test-only-key' },
			{ fetch: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch }
		)!;
		await expect(failing.cancelSubscriptions({ accountId: ACCT, customerRef: 'cus_Del2', subscriptionRefs: [] })).rejects.toMatchObject({ status: 503, code: 'billing_provider_error' });
		const keyless = billingProvider({ BILLING_PROVIDER: 'stripe', BILLING_WEBHOOK_SECRET: SECRET })!;
		await expect(keyless.cancelSubscriptions({ accountId: ACCT, customerRef: null, subscriptionRefs: ['sub_X'] })).rejects.toMatchObject({ code: 'billing_provider_error' });
	});

	it('manual refuses (a grant has nothing at a provider)', async () => {
		await expect(billingProvider({ BILLING_PROVIDER: 'manual' })!.cancelSubscriptions({ accountId: ACCT, customerRef: null, subscriptionRefs: [] })).rejects.toMatchObject({
			code: 'billing_unavailable'
		});
	});
});

describe('cancelOrphan (a subscription whose account is gone)', () => {
	const ACCT = '55555555-5555-4555-8555-555555555555';
	it('the mock answers it cancelled with nothing refunded, and makes no network call', async () => {
		const f = vi.fn(async () => new Response('{}'));
		const mock = billingProvider({ BILLING_PROVIDER: 'mock', BILLING_WEBHOOK_SECRET: SECRET }, { fetch: f as unknown as typeof fetch })!;
		expect(await mock.cancelOrphan({ accountId: ACCT, subscriptionRef: 'sub_mock_1' })).toEqual({ cancelled: true, refunds: 0, refundedMinor: 0, skipped: false });
		expect(f).not.toHaveBeenCalled();
	});

	it('stripe cancels and refunds through its API, and answers a failure or no key as the coded 503', async () => {
		const calls: string[] = [];
		const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			calls.push(`${init?.method} ${path}`);
			const body =
				path === '/v1/invoices'
					? { data: [{ id: 'in_A1', amount_paid: 100, billing_reason: 'subscription_create', status_transitions: { paid_at: Math.floor(Date.now() / 1000) - 60 } }] }
					: path === '/v1/invoice_payments'
						? { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_A1' } }] }
						: path === '/v1/refunds'
							? { amount: 100, status: 'succeeded' }
							: { status: init?.method === 'DELETE' ? 'canceled' : 'active' };
			return new Response(JSON.stringify(body), { status: 200 });
		});
		const p = billingProvider({ BILLING_PROVIDER: 'stripe', BILLING_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: 'test-only-key' }, { fetch: f as unknown as typeof fetch })!;
		expect(await p.cancelOrphan({ accountId: ACCT, subscriptionRef: 'sub_Orph1' })).toEqual({ cancelled: true, refunds: 1, refundedMinor: 100, skipped: false });
		expect(calls).toEqual(['GET /v1/subscriptions/sub_Orph1', 'GET /v1/invoices', 'DELETE /v1/subscriptions/sub_Orph1', 'GET /v1/invoice_payments', 'POST /v1/refunds']);

		const failing = billingProvider(
			{ BILLING_PROVIDER: 'stripe', BILLING_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: 'test-only-key' },
			{ fetch: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch }
		)!;
		await expect(failing.cancelOrphan({ accountId: ACCT, subscriptionRef: 'sub_Orph1' })).rejects.toMatchObject({ status: 503, code: 'billing_provider_error' });
		const keyless = billingProvider({ BILLING_PROVIDER: 'stripe', BILLING_WEBHOOK_SECRET: SECRET })!;
		await expect(keyless.cancelOrphan({ accountId: ACCT, subscriptionRef: 'sub_Orph1' })).rejects.toMatchObject({ code: 'billing_provider_error' });
	});
});
