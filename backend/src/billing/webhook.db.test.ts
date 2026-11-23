// POST /billing/webhook/:provider against Postgres and 326's app_billing_apply
// (issue #641 Phase 3): a signed event changes the account's subscription, a
// replayed or forged one changes nothing, and the webhook never needs a user.
// The SQL's own edge cases are lane P's tests of 326.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { signPayload } from './provider/signature.js';

const SECRET = 'test-only-billing-secret-0000000000000000';
const PLACEHOLDER = '00000000-0000-4000-8000-000000000641';

let accountId: string;
let owner: Awaited<ReturnType<typeof signUp>>;
const run = crypto.randomUUID().slice(0, 8);

/** A fixture for this account, with ids unique to this run (the test database outlives it). */
function event(name: string, opts: { id?: string; sub?: string } = {}): string {
	const text = readFileSync(new URL(`../../fixtures/billing/${name}.json`, import.meta.url), 'utf8')
		.replaceAll(PLACEHOLDER, accountId)
		.replaceAll('sub_synthetic_0001', opts.sub ?? `sub_${run}`);
	const e = JSON.parse(text);
	e.id = opts.id ?? `${e.id}_${run}`;
	return JSON.stringify(e);
}
const post = (body: string, secret = SECRET) =>
	app.request('/billing/webhook/mock', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'stripe-signature': signPayload(secret, body, Date.now() / 1000) },
		body
	});
const subscription = async () =>
	(await asOwner('SELECT status, plan_code, provider, external_ref FROM subscription WHERE billing_account_id = $1 ORDER BY created_at DESC LIMIT 1', [accountId]))[0] as
		| { status: string; plan_code: string; provider: string; external_ref: string }
		| undefined;

beforeAll(async () => {
	vi.stubEnv('BILLING_PROVIDER', 'mock');
	vi.stubEnv('BILLING_WEBHOOK_SECRET', SECRET);
	owner = await signUp('BillHook');
	accountId = (await owner.call('GET', '/account/plan')).body.account.id;
});
afterAll(() => vi.unstubAllEnvs());

describe('POST /billing/webhook/mock against app_billing_apply', () => {
	it('a signed subscription event creates the account’s subscription, and its plan shows it', async () => {
		const res = await app.request('/billing/webhook/mock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); // unsigned: nothing
		expect(res.status).toBe(400);
		expect(await subscription()).toBeUndefined();

		const created = await post(event('subscription-created'));
		expect(created.status).toBe(200);
		expect(await created.json()).toEqual({ received: true, result: 'applied' });
		expect(await subscription()).toEqual({ status: 'trialing', plan_code: 'pro', provider: 'mock', external_ref: `sub_${run}` });
		expect((await owner.call('GET', '/account/plan')).body.plan.code).toBe('pro');
	});

	it('a redelivery of the same event id is a duplicate and changes nothing', async () => {
		const body = event('subscription-updated');
		expect(await (await post(body)).json()).toEqual({ received: true, result: 'applied' });
		expect((await subscription())?.status).toBe('active');
		// The operator moves it by hand meanwhile; a replay of the old event must not undo that.
		await asOwner("UPDATE subscription SET status = 'past_due' WHERE billing_account_id = $1", [accountId]);
		expect(await (await post(body)).json()).toEqual({ received: true, result: 'duplicate' });
		expect((await subscription())?.status).toBe('past_due');
	});

	it('a forged event (wrong key) is 400 and changes nothing, and is not recorded', async () => {
		const forged = event('subscription-deleted');
		expect((await post(forged, 'dev-only-someone-elses-key-000000000000')).status).toBe(400);
		expect((await subscription())?.status).toBe('past_due');
		expect(await asOwner('SELECT 1 FROM billing_event WHERE event_id = $1', [JSON.parse(forged).id])).toHaveLength(0);
		// Signed properly, the same event applies (positive control).
		expect(await (await post(forged)).json()).toEqual({ received: true, result: 'applied' });
		expect((await subscription())?.status).toBe('canceled');
	});

	it('a recorded-only event is recorded once, and an unknown account is answered 200 and changes nothing', async () => {
		expect(await (await post(event('invoice-paid'))).json()).toEqual({ received: true, result: 'recorded' });
		const stranger = event('subscription-updated', { id: `evt_stranger_${run}`, sub: `sub_stranger_${run}` }).replaceAll(accountId, crypto.randomUUID());
		const res = await post(stranger);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ received: true, result: 'unknown_account' });
		expect(await asOwner('SELECT 1 FROM subscription WHERE external_ref = $1', [`sub_stranger_${run}`])).toHaveLength(0);
	});
});
