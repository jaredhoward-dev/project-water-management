// Buying Pro during the reverse trial against Postgres (344_trial_checkout, billing/routes.ts checkoutBlockedBy;
// docs/billing.md § The reverse trial):
//   - checkout opens for an account whose only live subscription is a reverse trial (manual + trialing), and the
//     mock's "pays" goes through the real webhook route to app_billing_apply: the paid plan is live, the trial is
//     expired (its end moved to now) and logged, one live subscription throughout;
//   - a replayed event is a duplicate, and a later update to the paid plan logs nothing more;
//   - a staff grant (manual + active) still refuses checkout (409), and a paid event for that account is still a
//     conflict that leaves the grant alone; a 'manual' event never ends a trial;
//   - the paid plan's own trial isn't mistaken for a reverse trial.
// Runs under the workspace's skewed TZ (CLAUDE.md rule 7): every time here is compared in Postgres.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser } from '../db/tx.js';

const SECRET = 'test-only-billing-secret-0000000000000000';
type User = Awaited<ReturnType<typeof signUp>>;

const local = (url: string) => {
	const u = new URL(url);
	return `${u.pathname}${u.search}`;
};
const formPost = (path: string) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
const apply = (type: string, payload: unknown, eventId = `evt_${randomUUID()}`, provider = 'mock') =>
	withoutUser(
		async (db) =>
			(await db.query<{ r: string }>('SELECT app_billing_apply($1, $2, $3, $4::jsonb) AS r', [provider, eventId, type, JSON.stringify(payload)])).rows[0]!.r
	);
const paid = (account: string, ref: string, over: Record<string, unknown> = {}) => ({
	accountId: account,
	planCode: 'pro',
	status: 'active',
	seats: 1,
	periodStart: '2026-11-01T00:00:00Z',
	periodEnd: '2026-12-01T00:00:00Z',
	trialEnd: null,
	cancelAtPeriodEnd: false,
	externalRef: ref,
	...over
});

/** A person with a billing account in a live reverse trial, as 342's app_reverse_trial_start writes one. */
async function trialist(name: string): Promise<{ user: User; account: string; trial: string }> {
	const user = await signUp(name);
	const account = (await user.call('GET', '/account/plan')).body.account.id as string;
	const [row] = await asOwner(
		`INSERT INTO subscription (billing_account_id, plan_code, status, period_start, period_end, trial_end, cancel_at_period_end, provider)
		 VALUES ($1, 'pro', 'trialing', now() - interval '2 days', now() + interval '12 days', now() + interval '12 days', true, 'manual') RETURNING id`,
		[account]
	);
	await asOwner(
		`INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
		 VALUES ($1, $2, 'grant', 'pro', now() + interval '12 days', 'the 14-day Pro trial for a newly verified person', 'reverse trial')`,
		[account, row!.id]
	);
	return { user, account, trial: row!.id as string };
}
const live = async (account: string) =>
	await asOwner(`SELECT provider, status FROM subscription WHERE billing_account_id = $1 AND status IN ('trialing', 'active', 'past_due')`, [account]);
const log = async (account: string) =>
	await asOwner('SELECT action, granted_by, subscription_id FROM billing_grant_log WHERE billing_account_id = $1 ORDER BY created_at', [account]);

beforeAll(() => {
	vi.stubEnv('BILLING_PROVIDER', 'mock');
	vi.stubEnv('BILLING_WEBHOOK_SECRET', SECRET);
});
afterAll(() => {
	vi.unstubAllEnvs();
});

describe('buying Pro during the reverse trial', () => {
	it('mock checkout → webhook: Pro paid and live, the trial expired now and logged, one live plan throughout', async () => {
		const { user, account, trial } = await trialist('TcBuyer');
		expect((await user.call('GET', '/account/plan')).body.subscription).toMatchObject({ status: 'trialing' });

		const start = await user.call('POST', '/account/plan/checkout', { plan: 'pro', interval: 'month' });
		expect(start.status).toBe(200);
		const done = await formPost(`${local(start.body.url)}&outcome=pays`);
		expect(done.status).toBe(303);
		expect(done.headers.get('location')).toMatch(/\/account\/plan\?checkout=done$/);

		const plan = (await user.call('GET', '/account/plan')).body;
		expect(plan.plan.code).toBe('pro');
		expect(plan.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: false });
		expect(await live(account)).toEqual([{ provider: 'mock', status: 'active' }]);
		const [ended] = await asOwner(
			`SELECT status, period_end <= now() AS ended_now, period_end >= period_start AS after_start, trial_end = period_end AS same
			 FROM subscription WHERE id = $1`,
			[trial]
		);
		expect(ended).toEqual({ status: 'expired', ended_now: true, after_start: true, same: true });
		expect(await log(account)).toEqual([
			{ action: 'grant', granted_by: 'reverse trial', subscription_id: trial },
			{ action: 'expire', granted_by: 'checkout', subscription_id: trial }
		]);
		const events = await asOwner('SELECT outcome FROM billing_event WHERE account_id = $1 AND type = $2', [account, 'subscription.updated']);
		expect(events.map((e) => e.outcome)).toEqual(['applied']);
		// The claim isn't touched: the person had their trial. A second checkout is refused (the paid plan is live).
		expect((await user.call('POST', '/account/plan/checkout', { plan: 'pro', interval: 'month' })).status).toBe(409);
	});

	it('a replay is a duplicate, and a later update to the paid plan logs nothing more', async () => {
		const { account } = await trialist('TcReplay');
		const ref = `sub_tc_${randomUUID()}`;
		const id = `evt_${randomUUID()}`;
		expect(await apply('subscription.created', paid(account, ref), id)).toBe('applied');
		expect(await apply('subscription.created', paid(account, ref), id)).toBe('duplicate');
		expect(await apply('subscription.updated', paid(account, ref, { cancelAtPeriodEnd: true }))).toBe('applied');
		expect(await live(account)).toEqual([{ provider: 'mock', status: 'active' }]);
		expect((await log(account)).map((r) => r.action)).toEqual(['grant', 'expire']);
	});

	it('a paid plan’s own trial (the provider’s trialing) ends the reverse trial too, and isn’t one itself', async () => {
		const { user, account } = await trialist('TcProviderTrial');
		expect(await apply('subscription.created', paid(account, `sub_tc_${randomUUID()}`, { status: 'trialing', trialEnd: '2026-12-01T00:00:00Z' }))).toBe('applied');
		expect(await live(account)).toEqual([{ provider: 'mock', status: 'trialing' }]);
		expect((await user.call('POST', '/account/plan/checkout', { plan: 'pro', interval: 'month' })).status).toBe(409);
	});
});

describe('what still refuses', () => {
	it('a staff grant: checkout 409, and a paid event is a conflict that leaves the grant alone', async () => {
		const user = await signUp('TcGranted');
		const account = (await user.call('GET', '/account/plan')).body.account.id as string;
		// Positive control: with no live plan, checkout opens.
		expect((await user.call('POST', '/account/plan/checkout', { plan: 'pro', interval: 'month' })).status).toBe(200);
		await asOwner(
			`INSERT INTO subscription (billing_account_id, plan_code, status, period_start, period_end, cancel_at_period_end, provider)
			 VALUES ($1, 'pro', 'active', now(), now() + interval '30 days', true, 'manual')`,
			[account]
		);
		expect((await user.call('POST', '/account/plan/checkout', { plan: 'pro', interval: 'month' })).status).toBe(409);
		expect(await apply('subscription.created', paid(account, `sub_tc_${randomUUID()}`))).toBe('conflict');
		expect(await live(account)).toEqual([{ provider: 'manual', status: 'active' }]);
		expect(await log(account)).toEqual([]);
	});

	it('a manual event never ends a reverse trial; a free-plan event neither', async () => {
		const { account } = await trialist('TcManual');
		expect(await apply('subscription.created', paid(account, `sub_tc_${randomUUID()}`), undefined, 'manual')).toBe('conflict');
		expect(await apply('subscription.created', paid(account, `sub_tc_${randomUUID()}`, { planCode: 'free' }))).toBe('conflict');
		expect(await live(account)).toEqual([{ provider: 'manual', status: 'trialing' }]);
		expect((await log(account)).map((r) => r.action)).toEqual(['grant']);
	});
});
