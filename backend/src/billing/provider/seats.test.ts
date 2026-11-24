// Changing a Team's seats through the providers (provider.ts changeSeats,
// stripeApi.ts; docs/billing.md § Changing a Team's seats), the HTTP layer
// mocked: never a live call. Stripe: read the items, then update the
// extra-seat item's quantity, add it (making its product once), or remove it,
// each with proration_behavior=create_prorations and an idempotency key. The
// mock: one signed customer.subscription.updated with the new quantity. Manual:
// refused with billing_unavailable.
import { describe, expect, it, vi } from 'vitest';
import { billingProvider, type CheckoutPlan, type SeatChange } from '../provider.js';
import { normaliseStripeEvent } from './stripe.js';
import { seatsChangedEvent } from './mock.js';
import { STRIPE_API_VERSION, StripeApiError } from './stripeApi.js';

const KEY = 'test-only-not-a-stripe-key';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const NOW = 1_800_000_000_000;
const TEAM: CheckoutPlan = {
	code: 'team',
	name: 'Team',
	priceMonthlyMinor: 249900,
	priceAnnualMinor: 2499000,
	currency: 'ZAR',
	seatsIncluded: 3,
	extraSeatMonthlyMinor: 49900,
	extraSeatAnnualMinor: 499000
};
const change = (seats: number, current = 3): SeatChange => ({
	accountId: ACCOUNT,
	externalRef: 'sub_Team1',
	plan: TEAM,
	subscription: { planCode: 'team', status: 'active', periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-12-01T00:00:00.000Z', cancelAtPeriodEnd: false, seats: current, seatsIncluded: 3 },
	seats
});

const item = (id: string, quantity: number, productName: string, interval = 'year', productId = 'prod_x') => ({
	id,
	object: 'subscription_item',
	quantity,
	price: { id: `price_${id}`, currency: 'zar', recurring: { interval }, product: { id: productId, name: productName } }
});
const BASE = item('si_Base1', 1, 'IC-WBT Team');
const EXTRA = (q: number) => item('si_Extra1', q, 'IC-WBT Team: extra editor seat');

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: Record<string, string>;
}
/** A Stripe that answers the subscription with `items`, and `product` for POST /v1/products. */
function fakeStripe(items: unknown[], product: { status: number; body: unknown } = { status: 200, body: { id: 'wm_team_extra_seat' } }) {
	const calls: Call[] = [];
	const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const u = String(url);
		calls.push({ url: u, method: init!.method!, headers: init!.headers as Record<string, string>, body: Object.fromEntries(new URLSearchParams(String(init!.body ?? ''))) });
		if (u.includes('/v1/subscriptions/')) return Response.json({ id: 'sub_Team1', object: 'subscription', items: { object: 'list', data: items } });
		if (u.endsWith('/v1/products')) return Response.json(product.body, { status: product.status });
		return Response.json({ id: 'si_New1', object: 'subscription_item' });
	});
	return { provider: billingProvider({ BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: KEY }, { fetch: f as unknown as typeof fetch, now: () => NOW })!, calls };
}
const minute = Math.floor(NOW / 60_000);

describe('stripe: changeSeats', () => {
	it('reads the subscription’s items with each price’s product expanded, under the pinned version', async () => {
		const { provider, calls } = fakeStripe([BASE, EXTRA(2)]);
		await provider.changeSeats(change(6, 5));
		expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.stripe.com/v1/subscriptions/sub_Team1?expand%5B0%5D=items.data.price.product' });
		expect(calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'Stripe-Version': STRIPE_API_VERSION });
	});

	it('update: the extra-seat item’s new quantity, prorated, with an idempotency key', async () => {
		const { provider, calls } = fakeStripe([EXTRA(2), BASE]);
		await provider.changeSeats(change(6, 5));
		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({
			method: 'POST',
			url: 'https://api.stripe.com/v1/subscription_items/si_Extra1',
			body: { quantity: '3', proration_behavior: 'create_prorations' }
		});
		expect(calls[1]!.headers['Idempotency-Key']).toBe(`wm-seats-sub_Team1-si_Extra1-2-3-${minute}`);
	});

	it('add: the product made once under a fixed id, then the item at the extra-seat price for the subscription’s interval', async () => {
		const { provider, calls } = fakeStripe([BASE]);
		await provider.changeSeats(change(5));
		expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.stripe.com', '').split('?')[0]}`)).toEqual([
			'GET /v1/subscriptions/sub_Team1',
			'POST /v1/products',
			'POST /v1/subscription_items'
		]);
		expect(calls[1]!.body).toEqual({ id: 'wm_team_extra_seat', name: 'IC-WBT Team: extra editor seat' });
		expect(calls[2]!.body).toEqual({
			subscription: 'sub_Team1',
			quantity: '2',
			'price_data[currency]': 'zar',
			'price_data[product]': 'wm_team_extra_seat',
			'price_data[unit_amount]': '499000',
			'price_data[recurring][interval]': 'year',
			proration_behavior: 'create_prorations'
		});
		expect(calls[2]!.headers['Idempotency-Key']).toBe(`wm-seats-sub_Team1-none-0-2-${minute}`);
	});

	it('add: a product that already exists (resource_already_exists) is reused', async () => {
		const { provider, calls } = fakeStripe([BASE], { status: 400, body: { error: { type: 'invalid_request_error', code: 'resource_already_exists' } } });
		await provider.changeSeats(change(4));
		expect(calls[2]).toMatchObject({ url: 'https://api.stripe.com/v1/subscription_items', body: { quantity: '1', 'price_data[product]': 'wm_team_extra_seat' } });
	});

	it('remove: back to the included seats deletes the extra-seat item, prorated, parameters in the query', async () => {
		const { provider, calls } = fakeStripe([BASE, EXTRA(2)]);
		await provider.changeSeats(change(3, 5));
		expect(calls[1]).toMatchObject({ method: 'DELETE', url: 'https://api.stripe.com/v1/subscription_items/si_Extra1?proration_behavior=create_prorations', body: {} });
		expect(calls[1]!.headers['Content-Type']).toBeUndefined();
	});

	it('changes nothing on a hand-edited subscription (two extra-seat items, an unknown one, the plan item at quantity 2, an extra-seat item at another interval), answering billing_provider_error', async () => {
		for (const items of [
			[BASE, EXTRA(1), item('si_Extra2', 1, 'IC-WBT Team: extra editor seat')],
			[BASE, item('si_Odd1', 2, 'Something else')],
			[item('si_Base1', 2, 'IC-WBT Team')],
			[BASE, item('si_Extra1', 2, 'IC-WBT Team: extra editor seat', 'month')]
		]) {
			const { provider, calls } = fakeStripe(items);
			await expect(provider.changeSeats(change(6))).rejects.toMatchObject({ status: 503, code: 'billing_provider_error' });
			expect(calls).toHaveLength(1);
		}
	});

	it('a Stripe error is billing_provider_error, never its text', async () => {
		const f = vi.fn(async () => Response.json({ error: { type: 'api_error', message: 'secret detail' } }, { status: 500 }));
		const p = billingProvider({ BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: KEY }, { fetch: f as unknown as typeof fetch })!;
		const e = await p.changeSeats(change(5)).catch((x: unknown) => x);
		expect(e).toMatchObject({ status: 503, code: 'billing_provider_error' });
		expect(String((e as Error).message)).not.toContain('secret detail');
		expect((e as { cause?: unknown }).cause).toBeInstanceOf(StripeApiError);
	});
});

describe('mock and manual: changeSeats', () => {
	it('the mock’s event carries the new extra quantity, and the normaliser reads it back as the seats', () => {
		const sub = change(5).subscription;
		for (const [seats, items] of [
			[5, 2],
			[3, 1]
		] as const) {
			const event = seatsChangedEvent(ACCOUNT, sub, 3, seats, NOW);
			expect(event.type).toBe('customer.subscription.updated');
			expect((event.data as { object: { items: { data: unknown[] } } }).object.items.data).toHaveLength(items);
			const r = normaliseStripeEvent(event);
			expect(r).toMatchObject({ kind: 'event', event: { type: 'subscription.updated', payload: { accountId: ACCOUNT, seats, planCode: 'team', status: 'active' } } });
		}
	});

	it('manual refuses with billing_unavailable', async () => {
		await expect(billingProvider({ BILLING_PROVIDER: 'manual' })!.changeSeats(change(5))).rejects.toMatchObject({ status: 409, code: 'billing_unavailable' });
	});

	it('the mock without its secret is billing_provider_error', async () => {
		await expect(billingProvider({ BILLING_PROVIDER: 'mock' })!.changeSeats(change(5))).rejects.toMatchObject({ status: 503, code: 'billing_provider_error' });
	});
});
