// The provider choice (provider.ts): mock by default, manual takes no webhooks,
// stripe and mock check the signature, and a name that isn't ours is no
// provider at all (never the mock).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { billingProvider, billingProviderName } from './provider.js';
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
