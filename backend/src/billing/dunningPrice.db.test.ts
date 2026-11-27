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
import pg from 'pg';
import { DUNNING_GRACE_DAYS } from '@water-management/engine/plans';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { OWNER_URL } from '../__tests__/test-db.js';
import { gatherReport } from '../../scripts/billing-report.js';
import { withoutUser, withUser } from '../db/tx.js';
import { ownerActionCode, parseOwnerAction, runOwnerAction } from '../ops/ownerActions.js';
import { ConflictError, listConflicts, resolveConflict } from './conflicts.js';
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

const report = () => gatherReport(OWNER_URL, '2001-03', new Date());

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

describe('406: a price conflict is kept for the operator', () => {
	let owner: User;
	let account: string;
	const t0 = Math.floor(Date.now() / 1000) - 3600;
	const ref = `sub_cf_${run}`;
	const held = `sub_cf_held_${run}`;
	const conflicts = async (r: string) =>
		(await asOwner(
			`SELECT reason, plan_code, billing_interval, seats, amount_minor::int AS amount, currency, expected_minor::int AS expected, held, resolved_at
			 FROM billing_conflict WHERE provider = 'mock' AND external_ref = $1 ORDER BY id`,
			[r]
		)) as { reason: string; amount: number | null; expected: number | null; held: boolean; resolved_at: Date | null }[];

	beforeAll(async () => {
		owner = await signUp('PriceConflict');
		account = (await owner.call('GET', '/account/plan')).body.account.id;
	});

	it('records a refused new subscription (not held) with its reason and amounts, and the report lists it', async () => {
		expect(await post(event('subscription-pro-repriced', account, { sub: ref, created: t0 }))).toBe('conflict');
		expect(await post(event('subscription-pro-coupon', account, { sub: ref, created: t0 + 1 }))).toBe('conflict');
		expect(await post(event('subscription-pro-priced', account, { sub: ref, created: t0 + 2, currency: 'usd' }))).toBe('conflict');
		const rows = await conflicts(ref);
		expect(rows.map((r) => [r.reason, r.amount, r.expected, r.held])).toEqual([
			['amount', 100, 89900, false],
			['discount', 89900, 89900, false],
			['currency', 89900, 89900, false]
		]);
		expect(rows[0]).toMatchObject({ plan_code: 'pro', billing_interval: 'month', seats: 1, currency: 'zar', resolved_at: null });

		const mine = (await report()).billingConflicts.filter((c) => c.externalRef === ref);
		expect(mine).toHaveLength(3);
		expect(mine[0]).toMatchObject({ accountId: account, reason: 'amount', amountMinor: 100, expectedMinor: 89900, held: false });
		expect(JSON.stringify(mine)).not.toMatch(/@/); // ids and amounts, never an address
	});

	it('a later event that applies for the ref resolves its open conflicts, and the report drops them', async () => {
		expect(await post(event('subscription-pro-priced', account, { sub: ref, created: t0 + 3 }))).toBe('applied');
		expect((await conflicts(ref)).every((r) => r.resolved_at !== null)).toBe(true);
		expect((await report()).billingConflicts.filter((c) => c.externalRef === ref)).toEqual([]);
	});

	it('a held subscription whose price drifted is recorded as held, and stays open until something applies', async () => {
		const other = await signUp('PriceConflictHeld');
		const acc = (await other.call('GET', '/account/plan')).body.account.id as string;
		expect(await post(event('subscription-pro-priced', acc, { sub: held, created: t0 }))).toBe('applied');
		expect(await post(event('subscription-pro-repriced', acc, { sub: held, created: t0 + 1 }))).toBe('conflict');
		expect((await conflicts(held)).map((r) => [r.reason, r.held, r.resolved_at])).toEqual([['amount', true, null]]);
		expect((await report()).billingConflicts.some((c) => c.externalRef === held && c.held)).toBe(true);
	});

	it('the purge keeps open rows and deletes resolved ones past the retention', async () => {
		await asOwner(`UPDATE billing_conflict SET resolved_at = now() - interval '100 days' WHERE provider = 'mock' AND external_ref = $1`, [ref]);
		await withoutUser((db) => db.query(`SELECT app_purge_billing_events(interval '90 days')`));
		expect(await conflicts(ref)).toEqual([]);
		expect(await conflicts(held)).toHaveLength(1);
	});

	it('water_app reads none of it', async () => {
		const failure = await withUser(owner.id, (db) => db.query('SELECT 1 FROM billing_conflict LIMIT 1')).then(
			() => 'ok',
			(e: { code?: string }) => String(e.code)
		);
		expect(failure).toBe('42501');
	});
});

describe('406: the operator resolves a conflict by hand (pnpm dev:billing:conflict, the owner actions)', () => {
	const t0 = Math.floor(Date.now() / 1000) - 1800;
	const ref = `sub_cf_hand_${run}`;

	it('lists it open, resolves it with who and why kept, refuses a second resolve and an unknown id', async () => {
		const u = await signUp('ConflictHand');
		const acc = (await u.call('GET', '/account/plan')).body.account.id as string;
		expect(await post(event('subscription-pro-repriced', acc, { sub: ref, created: t0 }))).toBe('conflict');

		const owner = new pg.Client({ connectionString: OWNER_URL });
		await owner.connect();
		try {
			const open = (await listConflicts(owner)).filter((c) => c.externalRef === ref);
			expect(open).toHaveLength(1);
			expect(open[0]).toMatchObject({ accountId: acc, reason: 'amount', held: false, resolvedAt: null });

			const r = await runOwnerAction(owner, parseOwnerAction({ action: 'billing-conflict-resolve', via: 'workflow', conflictId: open[0]!.id, reason: 'Refunded in Stripe', by: 'operator' }));
			expect(r).toMatchObject({ action: 'billing-conflict-resolve', conflict: { id: open[0]!.id, resolvedBy: 'operator', resolution: 'Refunded in Stripe' } });
			expect((await listConflicts(owner)).some((c) => c.externalRef === ref)).toBe(false);
			expect((await listConflicts(owner, true)).find((c) => c.externalRef === ref)?.resolvedAt).not.toBeNull();
			expect((await report()).billingConflicts.some((c) => c.externalRef === ref)).toBe(false);

			const again = await resolveConflict(owner, { id: open[0]!.id, reason: 'twice', by: 'operator' }).catch((e: Error) => e);
			expect(again).toBeInstanceOf(ConflictError);
			expect(ownerActionCode(again)).toBe('invalid');
			const none = await resolveConflict(owner, { id: 999_999_999, reason: 'x', by: 'operator' }).catch((e: Error) => e);
			expect(ownerActionCode(none)).toBe('no_conflict');
			// The by 'event' marker is the webhook's own.
			expect(await resolveConflict(owner, { id: open[0]!.id, reason: 'x', by: 'event' }).catch((e: ConflictError) => e.code)).toBe('invalid');
		} finally {
			await owner.end();
		}
	});

	it('the app role cannot resolve one', async () => {
		const u = await signUp('ConflictStranger');
		const code = await withUser(u.id, (db) => db.query(`SELECT app_billing_conflict_resolve(1, 'x', 'y')`)).then(
			() => 'ok',
			(e: { code?: string }) => String(e.code)
		);
		expect(code).toBe('42501');
	});
});
