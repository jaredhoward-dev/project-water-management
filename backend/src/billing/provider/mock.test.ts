// The mock provider's sessions and events (mock.ts): a token is good only
// with the dev key, for its kind and until it expires; the events it makes
// are ones the real normaliser accepts, for the account and plan it names.
import { describe, expect, it } from 'vitest';
import { cancelAtPeriodEndEvent, mockSubscriptionRef, paidEvents, readMockSession, signedDelivery, signMockSession, type MockSession } from './mock.js';
import { verifySignature } from './signature.js';
import { normaliseStripeEvent } from './stripe.js';

const SECRET = 'test-only-billing-secret-0000000000000000';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const checkout: Extract<MockSession, { kind: 'checkout' }> = {
	kind: 'checkout',
	accountId: ACCOUNT,
	planCode: 'pro',
	planName: 'Pro',
	amountMinor: 89900,
	currency: 'ZAR',
	interval: 'month',
	successUrl: 'http://localhost:7777/account/plan?checkout=done',
	cancelUrl: 'http://localhost:7777/account/plan?checkout=cancelled',
	exp: NOW / 1000 + 3600
};

describe('mock sessions', () => {
	it('reads back what it signed', () => {
		expect(readMockSession(SECRET, signMockSession(SECRET, checkout), NOW)).toEqual(checkout);
	});

	it('refuses another key, a changed payload, an expired token and junk', () => {
		const t = signMockSession(SECRET, checkout);
		expect(readMockSession('another-secret', t, NOW)).toBeNull();
		expect(readMockSession(undefined, t, NOW)).toBeNull();
		const [payload, mac] = t.split('.') as [string, string];
		const other = Buffer.from(JSON.stringify({ ...checkout, accountId: '33333333-3333-4333-8333-333333333333' })).toString('base64url');
		expect(readMockSession(SECRET, `${other}.${mac}`, NOW)).toBeNull();
		expect(readMockSession(SECRET, `${payload}.`, NOW)).toBeNull();
		expect(readMockSession(SECRET, t, NOW + 3601_000)).toBeNull();
		for (const junk of ['', '.', 'abc', null, undefined, 'x'.repeat(9000)]) expect(readMockSession(SECRET, junk, NOW)).toBeNull();
	});

	it('is not a webhook signature: the same key signs in another context', () => {
		const t = signMockSession(SECRET, checkout);
		const [payload, mac] = t.split('.') as [string, string];
		expect(verifySignature(payload, `t=${Math.floor(NOW / 1000)},v1=${Buffer.from(mac, 'base64url').toString('hex')}`, SECRET, NOW)).toBe(false);
	});
});

describe('mock events', () => {
	it('pays: the session completed, then an active subscription for the account and plan, a month long', () => {
		const [done, created] = paidEvents(checkout, NOW).map((e) => normaliseStripeEvent(e));
		expect(done).toMatchObject({ kind: 'event', event: { type: 'checkout.completed', payload: { accountId: ACCOUNT, externalRef: mockSubscriptionRef(ACCOUNT) } } });
		expect(created).toMatchObject({
			kind: 'event',
			event: {
				type: 'subscription.updated',
				payload: {
					accountId: ACCOUNT,
					planCode: 'pro',
					status: 'active',
					seats: 1,
					periodStart: '2026-11-23T12:00:00.000Z',
					periodEnd: '2026-12-23T12:00:00.000Z',
					cancelAtPeriodEnd: false,
					externalRef: `sub_mock_${ACCOUNT.replace(/-/g, '')}`
				}
			}
		});
	});

	it('pays yearly: a year long', () => {
		const created = normaliseStripeEvent(paidEvents({ ...checkout, interval: 'year' }, NOW)[1]);
		expect(created).toMatchObject({ event: { payload: { periodEnd: '2027-11-23T12:00:00.000Z' } } });
	});

	it('gives each event its own id', () => {
		const ids = [...paidEvents(checkout, NOW), ...paidEvents(checkout, NOW)].map((e) => e.id);
		expect(new Set(ids).size).toBe(4);
	});

	it('the portal’s cancel: the same subscription, cancelling at the period end; nothing without one', () => {
		const portal: Extract<MockSession, { kind: 'portal' }> = {
			kind: 'portal',
			accountId: ACCOUNT,
			returnUrl: 'http://localhost:7777/account/plan',
			subscription: { planCode: 'pro', status: 'active', periodStart: '2026-11-23T12:00:00.000Z', periodEnd: '2026-12-23T12:00:00.000Z', cancelAtPeriodEnd: false, seats: 1 },
			exp: NOW / 1000 + 3600
		};
		expect(normaliseStripeEvent(cancelAtPeriodEndEvent(portal, NOW))).toMatchObject({
			event: { type: 'subscription.updated', payload: { status: 'active', cancelAtPeriodEnd: true, externalRef: mockSubscriptionRef(ACCOUNT), periodEnd: '2026-12-23T12:00:00.000Z' } }
		});
		expect(cancelAtPeriodEndEvent({ ...portal, subscription: null }, NOW)).toBeNull();
	});

	it('signs a delivery the webhook’s check accepts', () => {
		const { body, signature } = signedDelivery(SECRET, paidEvents(checkout, NOW)[0]!, NOW);
		expect(verifySignature(body, signature, SECRET, NOW)).toBe(true);
	});
});
