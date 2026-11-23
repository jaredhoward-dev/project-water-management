// The provider choice (provider.ts): mock by default, manual takes no webhooks,
// stripe and mock check the signature, and a name that isn't ours is no
// provider at all (never the mock).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { billingProvider, billingProviderName, type CheckoutPlan, type ReturnUrls } from './provider.js';
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
	const PRO: CheckoutPlan = { code: 'pro', name: 'Pro', priceMonthlyMinor: 89900, priceAnnualMinor: 899000, currency: 'ZAR' };
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
