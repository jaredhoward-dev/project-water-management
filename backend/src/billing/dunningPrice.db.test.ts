// 405_billing_dunning_and_price (issues #927, #928; docs/billing.md § Dunning limit, § Price check), through the
// signed mock webhook and the committed synthetic fixtures (backend/fixtures/billing/):
//  - #927: a subscription past_due for longer than DUNNING_GRACE_DAYS lapses on the job tick (the account reads
//    as Free, as after a cancellation), not before (positive control); a further past_due keeps it lapsed, a
//    payment (active) lifts it, a delete cancels it; only the worker runs the pass;
//  - #928: a live subscription event is applied only at the plan table's price (Pro monthly, Team with extra seats),
//    in its currency, with no discount; a dashboard price, another currency or a coupon is a conflict that writes
//    nothing; a price accepted before stays accepted on the same plan (a raised list price never strands a
//    subscriber); an ended status applies whatever its price.
import { readFileSync } from 'node:fs';
import { DUNNING_GRACE_DAYS } from '@water-management/engine/plans';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { signPayload } from './provider/signature.js';

const SECRET = 'test-only-billing-secret-0000000000000000';
const PLACEHOLDER = '00000000-0000-4000-8000-000000000641';
const run = crypto.randomUUID().slice(0, 8);
let seq = 0;

type User = Awaited<ReturnType<typeof signUp>>;
type Patch = { sub: string; created?: number; status?: string; unit?: number; currency?: string };

/** A fixture for this account and subscription, with a fresh event id (the test database outlives the run). */
function event(name: string, account: string, p: Patch): string {
	const e = JSON.parse(
		readFileSync(new URL(`../../fixtures/billing/${name}.json`, import.meta.url), 'utf8').replaceAll(PLACEHOLDER, account).replaceAll('sub_synthetic_0001', p.sub)
	);
	e.id = `${e.id}_${run}_${++seq}`;
	if (p.created !== undefined) e.created = p.created;
	if (p.status !== undefined) e.data.object.status = p.status;
	const items = e.data.object.items.data as { price?: { unit_amount: number; currency: string } }[];
	if (p.unit !== undefined) items[0]!.price!.unit_amount = p.unit;
	if (p.currency !== undefined) for (const it of items) it.price!.currency = p.currency;
	return JSON.stringify(e);
}
const post = async (body: string) => {
	const res = await app.request('/billing/webhook/mock', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'stripe-signature': signPayload(SECRET, body, Date.now() / 1000) },
		body
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { result: string }).result;
};
const sub = async (ref: string) =>
	((await asOwner('SELECT status, plan_code, past_due_since, price_minor FROM subscription WHERE provider = $1 AND external_ref = $2', ['mock', ref])) as {
		status: string;
		plan_code: string;
		past_due_since: Date | null;
		price_minor: string | null;
	}[])[0];
const planOf = async (u: User) => (await u.call('GET', '/account/plan')).body.plan.code as string;
const tick = () => runTick({ feeds: false, reports: false, alerts: false, maxJobs: 0 });
const overdueFor = (ref: string, days: number) =>
	asOwner(`UPDATE subscription SET past_due_since = now() - make_interval(days => $2) WHERE provider = 'mock' AND external_ref = $1`, [ref, days]);

beforeAll(() => {
	vi.stubEnv('BILLING_PROVIDER', 'mock');
	vi.stubEnv('BILLING_WEBHOOK_SECRET', SECRET);
});
afterAll(() => vi.unstubAllEnvs());

describe('405 (#927): the dunning limit', () => {
	let owner: User;
	let account: string;
	const ref = `sub_dun_${run}`;
	const t0 = Math.floor(Date.now() / 1000) - 30 * 86400;

	beforeAll(async () => {
		owner = await signUp('Dunning');
		account = (await owner.call('GET', '/account/plan')).body.account.id;
	});

	it('past_due within the limit keeps the plan; past it, the tick lapses it to Free', async () => {
		expect(await post(event('subscription-updated', account, { sub: ref, created: t0 }))).toBe('applied');
		expect(await post(event('subscription-past-due', account, { sub: ref, created: t0 + 60 }))).toBe('applied');
		const due = await sub(ref);
		expect(due).toMatchObject({ status: 'past_due', plan_code: 'pro' });
		expect(due!.past_due_since).toEqual(new Date((t0 + 60) * 1000));

		// One day short of the limit: still Pro (positive control).
		await overdueFor(ref, DUNNING_GRACE_DAYS - 1);
		await tick();
		expect((await sub(ref))!.status).toBe('past_due');
		expect(await planOf(owner)).toBe('pro');

		await overdueFor(ref, DUNNING_GRACE_DAYS + 1);
		const r = await tick();
		expect(r.subscriptionsLapsed).toBeGreaterThanOrEqual(1);
		expect((await sub(ref))!.status).toBe('lapsed');
		expect(await planOf(owner)).toBe('free');
	});

	it('a further past_due keeps it lapsed, and its clock', async () => {
		const before = (await sub(ref))!.past_due_since;
		expect(await post(event('subscription-past-due', account, { sub: ref, created: t0 + 120 }))).toBe('applied');
		expect(await sub(ref)).toMatchObject({ status: 'lapsed', past_due_since: before });
		expect(await planOf(owner)).toBe('free');
	});

	it('a payment (active) lifts it at once and clears the clock', async () => {
		expect(await post(event('subscription-updated', account, { sub: ref, created: t0 + 180 }))).toBe('applied');
		expect(await sub(ref)).toMatchObject({ status: 'active', past_due_since: null });
		expect(await planOf(owner)).toBe('pro');
	});

	it('a delete cancels a lapsed subscription', async () => {
		expect(await post(event('subscription-past-due', account, { sub: ref, created: t0 + 240 }))).toBe('applied');
		await overdueFor(ref, DUNNING_GRACE_DAYS + 1);
		await tick();
		expect((await sub(ref))!.status).toBe('lapsed');
		expect(await post(event('subscription-deleted', account, { sub: ref, created: t0 + 300 }))).toBe('applied');
		expect((await sub(ref))!.status).toBe('canceled');
	});

	it('only the worker runs the pass, and never with a limit under a day', async () => {
		const failure = async (p: Promise<unknown>) => {
			try {
				await p;
				return 'ok';
			} catch (e) {
				return String((e as { code?: string }).code);
			}
		};
		expect(await failure(withUser(owner.id, (db) => db.query('SELECT app_billing_dunning_lapse(14)')))).toBe('42501');
		expect(await failure(withoutUser((db) => db.query('SELECT app_billing_dunning_lapse(0)')))).toBe('22023');
	});
});

describe('405 (#928): the price must be the plan’s', () => {
	let owner: User;
	let account: string;
	const t0 = Math.floor(Date.now() / 1000) - 86400;

	beforeAll(async () => {
		owner = await signUp('PriceCheck');
		account = (await owner.call('GET', '/account/plan')).body.account.id;
	});

	it('a dashboard price or another currency on a new subscription is a conflict that writes nothing', async () => {
		const ref = `sub_px_new_${run}`;
		expect(await post(event('subscription-pro-repriced', account, { sub: ref, created: t0 }))).toBe('conflict');
		expect(await post(event('subscription-pro-priced', account, { sub: ref, created: t0, currency: 'usd' }))).toBe('conflict');
		expect(await sub(ref)).toBeUndefined();
		expect(await planOf(owner)).toBe('free');
	});

	it('a coupon is a conflict', async () => {
		const ref = `sub_px_coupon_${run}`;
		expect(await post(event('subscription-pro-coupon', account, { sub: ref, created: t0 }))).toBe('conflict');
		expect(await sub(ref)).toBeUndefined();
	});

	it('the plan’s price applies and is kept; a later dashboard price or coupon changes nothing', async () => {
		const ref = `sub_px_${run}`;
		expect(await post(event('subscription-pro-priced', account, { sub: ref, created: t0 + 10 }))).toBe('applied');
		expect(await sub(ref)).toMatchObject({ status: 'active', plan_code: 'pro', price_minor: '89900' });
		expect(await post(event('subscription-pro-repriced', account, { sub: ref, created: t0 + 20 }))).toBe('conflict');
		expect(await post(event('subscription-pro-coupon', account, { sub: ref, created: t0 + 30 }))).toBe('conflict');
		expect(await sub(ref)).toMatchObject({ status: 'active', price_minor: '89900' });

		// A price accepted before (the list price has since moved) stays accepted on the same plan and interval.
		await asOwner(`UPDATE subscription SET price_minor = 79900 WHERE provider = 'mock' AND external_ref = $1`, [ref]);
		expect(await post(event('subscription-pro-priced', account, { sub: ref, created: t0 + 40, unit: 79900 }))).toBe('applied');
		expect(await post(event('subscription-pro-priced', account, { sub: ref, created: t0 + 50, unit: 69900 }))).toBe('conflict');

		// An ended status applies whatever its price.
		expect(await post(event('subscription-pro-repriced', account, { sub: ref, created: t0 + 60, status: 'canceled' }))).toBe('applied');
		expect((await sub(ref))!.status).toBe('canceled');
	});

	it('Team with extra seats at the plan’s seat price applies; a cheaper seat is a conflict', async () => {
		const teamOwner = await signUp('PriceTeam');
		const acc = (await teamOwner.call('GET', '/account/plan')).body.account.id as string;
		const cheap = `sub_px_team_cheap_${run}`;
		expect(await post(event('subscription-team-seats', acc, { sub: cheap, created: t0, unit: 100 }).replaceAll('sub_synthetic_team_0001', cheap))).toBe('conflict');
		const ref = `sub_px_team_${run}`;
		expect(await post(event('subscription-team-seats', acc, { sub: ref, created: t0 }).replaceAll('sub_synthetic_team_0001', ref))).toBe('applied');
		expect(await sub(ref)).toMatchObject({ status: 'active', plan_code: 'team', price_minor: String(249900 + 2 * 49900) });
	});
});
