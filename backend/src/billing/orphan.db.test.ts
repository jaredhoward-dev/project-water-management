// A checkout paid after its account was deleted (352; docs/billing.md §
// Deleting an account): POST /billing/webhook/mock against Postgres, with the
// mock provider's cancelOrphan watched (and made to fail) through a wrapper.
// The live subscription or completed checkout whose account is gone is
// cancelled and refunded once across redeliveries, a failure answers 503 and
// leaves the event pending for the retry, and a known account applies as
// before (positive control). The Stripe calls themselves:
// provider/stripeApi.test.ts; the route without a database: webhook.test.ts.
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { signPayload } from './provider/signature.js';

const orphan = vi.hoisted(() => ({ asked: [] as { accountId: string; subscriptionRef: string }[], fail: false }));
vi.mock('./provider.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('./provider.js')>();
	return {
		...real,
		billingProvider: (...args: Parameters<typeof real.billingProvider>) => {
			const p = real.billingProvider(...args);
			if (!p) return p;
			return {
				...p,
				async cancelOrphan(req: { accountId: string; subscriptionRef: string }) {
					orphan.asked.push(req);
					if (orphan.fail) throw new real.BillingProviderError();
					return p.cancelOrphan(req);
				}
			};
		}
	};
});

const SECRET = 'test-only-billing-secret-0000000000000000';
const PLACEHOLDER = '00000000-0000-4000-8000-000000000641';
const run = crypto.randomUUID().slice(0, 8);

function event(name: string, account: string, opts: { id: string; sub: string }): string {
	const text = readFileSync(new URL(`../../fixtures/billing/${name}.json`, import.meta.url), 'utf8').replaceAll(PLACEHOLDER, account).replaceAll('sub_synthetic_0001', opts.sub);
	return JSON.stringify({ ...JSON.parse(text), id: opts.id });
}
const post = (body: string) =>
	app.request('/billing/webhook/mock', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'stripe-signature': signPayload(SECRET, body, Date.now() / 1000) },
		body
	});
const outcome = async (id: string) => ((await asOwner('SELECT outcome FROM billing_event WHERE provider = $1 AND event_id = $2', ['mock', id]))[0] as { outcome: string } | undefined)?.outcome;

beforeAll(() => {
	vi.stubEnv('BILLING_PROVIDER', 'mock');
	vi.stubEnv('BILLING_WEBHOOK_SECRET', SECRET);
});
afterEach(() => {
	orphan.asked.length = 0;
	orphan.fail = false;
});
afterAll(() => vi.unstubAllEnvs());

describe('a subscription for an account that is gone', () => {
	it('is cancelled and refunded once, and a redelivery of the event asks nothing more', async () => {
		const gone = crypto.randomUUID();
		const body = event('subscription-updated', gone, { id: `evt_orph_a_${run}`, sub: `sub_orph_a_${run}` });
		const res = await post(body);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ received: true, result: 'orphan_refunded' });
		expect(orphan.asked).toEqual([{ accountId: gone, subscriptionRef: `sub_orph_a_${run}` }]);
		expect(await outcome(`evt_orph_a_${run}`)).toBe('orphan_refunded');
		expect(await asOwner('SELECT 1 FROM subscription WHERE external_ref = $1', [`sub_orph_a_${run}`])).toHaveLength(0);

		expect(await (await post(body)).json()).toEqual({ received: true, result: 'duplicate' });
		expect(orphan.asked).toHaveLength(1);
	});

	it('answers 503 when the cancel or refund fails, keeps the event pending, and the redelivery finishes it, once', async () => {
		const gone = crypto.randomUUID();
		const body = event('subscription-updated', gone, { id: `evt_orph_b_${run}`, sub: `sub_orph_b_${run}` });
		orphan.fail = true;
		const res = await post(body);
		expect(res.status).toBe(503);
		expect(await res.text()).not.toMatch(/orphan_pending|app_billing/);
		expect(await outcome(`evt_orph_b_${run}`)).toBe('orphan_pending');

		orphan.fail = false;
		expect(await (await post(body)).json()).toEqual({ received: true, result: 'orphan_refunded' });
		expect(await outcome(`evt_orph_b_${run}`)).toBe('orphan_refunded');
		expect(await (await post(body)).json()).toEqual({ received: true, result: 'duplicate' });
		expect(orphan.asked).toHaveLength(2);
	});

	it('a completed checkout whose account is gone is an orphan too', async () => {
		const gone = crypto.randomUUID();
		const res = await post(event('checkout-completed', gone, { id: `evt_orph_c_${run}`, sub: `sub_orph_c_${run}` }));
		expect(await res.json()).toEqual({ received: true, result: 'orphan_refunded' });
		expect(orphan.asked).toEqual([{ accountId: gone, subscriptionRef: `sub_orph_c_${run}` }]);
	});

	it('an ended subscription for an account that is gone is left alone (unknown_account, as before)', async () => {
		const res = await post(event('subscription-deleted', crypto.randomUUID(), { id: `evt_orph_d_${run}`, sub: `sub_orph_d_${run}` }));
		expect(await res.json()).toEqual({ received: true, result: 'unknown_account' });
		expect(orphan.asked).toEqual([]);
		expect(await outcome(`evt_orph_d_${run}`)).toBe('unknown_account');
	});

	it('a known account applies and records as before, asking no cancel (positive control); its redelivery after the account goes is a plain duplicate', async () => {
		const owner = await signUp('OrphanControl');
		const accountId = (await owner.call('GET', '/account/plan')).body.account.id as string;
		const checkout = event('checkout-completed', accountId, { id: `evt_orph_e1_${run}`, sub: `sub_orph_e_${run}` });
		const updated = event('subscription-updated', accountId, { id: `evt_orph_e2_${run}`, sub: `sub_orph_e_${run}` });
		expect(await (await post(checkout)).json()).toEqual({ received: true, result: 'recorded' });
		expect(await (await post(updated)).json()).toEqual({ received: true, result: 'applied' });
		expect(orphan.asked).toEqual([]);

		// The account goes later (the delete cancelled its plan). A redelivery of an event that applied then is not an orphan.
		await asOwner('DELETE FROM billing_account WHERE id = $1', [accountId]);
		expect(await (await post(checkout)).json()).toEqual({ received: true, result: 'duplicate' });
		expect(await (await post(updated)).json()).toEqual({ received: true, result: 'duplicate' });
		expect(orphan.asked).toEqual([]);
	});

	it('the orphan functions run with no user only', async () => {
		const owner = await signUp('OrphanGuard');
		await expect(withUser(owner.id, (db) => db.query("SELECT app_billing_orphan_claim('mock', 'evt_x', true)"))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query("SELECT app_billing_orphan_done('mock', 'evt_x')"))).rejects.toMatchObject({ code: '42501' });
	});
});
