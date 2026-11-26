// The grant and trial expiry ticks' lock order (387_billing_expire_lock_order, issue #892; docs/billing.md §
// Staff grants). Every write to a subscription fires 341's pause sync, which takes 334's billing lock (an advisory
// lock on 'billing:' || account), so a writer must take that lock before the subscription's row lock, as
// app_billing_apply, 342, 344 and 374 do. Before 387 the ticks expired the rows first and met the billing lock in
// the trigger, already holding the row: against a webhook holding the billing lock and writing the row, a
// deadlock. Each case holds the account's billing lock (as a webhook in flight does), runs the tick, and expects
// it to wait on that advisory lock while holding no lock on the row: another connection can still lock the row
// at once (FOR UPDATE NOWAIT). Released, the tick expires the row and logs it (the positive control).
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';

const connect = async (url: string | undefined) => {
	const c = new pg.Client({ connectionString: url });
	await c.connect();
	return c;
};
const pidOf = async (c: pg.Client) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;

/** The lock kind the backend waits on, polling until it waits (null: it never did). */
async function waitingOn(pid: number): Promise<string | null> {
	for (let i = 0; i < 200; i++) {
		const [r] = await asOwner(
			`SELECT l.locktype FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted WHERE a.pid = $1 AND a.wait_event_type = 'Lock'`,
			[pid]
		);
		if (r) return r.locktype as string;
		await new Promise((res) => setTimeout(res, 25));
	}
	return null;
}

const CASES = [
	{
		fn: 'app_staff_grant_expire',
		plant: `INSERT INTO subscription (billing_account_id, plan_code, status, provider, period_start, period_end, cancel_at_period_end)
		        VALUES ($1, 'pro', 'active', 'manual', now() - interval '2 days', now() - interval '1 minute', true) RETURNING id`,
		reason: 'the grant reached its end'
	},
	{
		fn: 'app_reverse_trial_expire',
		plant: `INSERT INTO subscription (billing_account_id, plan_code, status, provider, period_start, period_end, trial_end)
		        VALUES ($1, 'pro', 'trialing', 'manual', now() - interval '14 days', now() - interval '1 minute', now() - interval '1 minute') RETURNING id`,
		reason: 'the trial reached its end'
	}
] as const;

describe('the expiry ticks take the billing lock before the subscription row', () => {
	for (const c of CASES) {
		it(`${c.fn} waits on the advisory lock holding no row lock, then expires the row`, async () => {
			const u = await signUp(c.fn === 'app_staff_grant_expire' ? 'LockGrant' : 'LockTrial');
			const account = (await asOwner(`SELECT billing_account_ensure('user', $1) AS a`, [u.id]))[0]!.a as string;
			const sub = (await asOwner(c.plant, [account]))[0]!.id as string;

			const webhook = await connect(process.env.TEST_MIGRATION_DATABASE_URL); // holds the billing lock, as app_billing_apply does
			const tick = await connect(process.env.DATABASE_URL); // water_app with no user: the worker's context
			const other = await connect(process.env.TEST_MIGRATION_DATABASE_URL);
			try {
				await webhook.query('BEGIN');
				await webhook.query(`SELECT pg_advisory_xact_lock(hashtext('billing:' || $1::text))`, [account]);
				const tickPid = await pidOf(tick);
				await tick.query('BEGIN');
				const expired = tick.query<{ n: number }>(`SELECT ${c.fn}() AS n`).then(
					(r) => r.rows[0]!.n,
					(e: { code?: string }) => `failed ${String(e.code)}`
				);
				expect(await waitingOn(tickPid)).toBe('advisory');
				// Before 387 the tick held the row here, so this failed with 55P03 (lock_not_available).
				await other.query('BEGIN');
				await expect(other.query('SELECT 1 FROM subscription WHERE id = $1 FOR UPDATE NOWAIT', [sub])).resolves.toMatchObject({ rowCount: 1 });
				await other.query('ROLLBACK');
				await webhook.query('COMMIT');
				expect(await expired).toBeGreaterThanOrEqual(1);
				await tick.query('COMMIT');
			} finally {
				for (const x of [webhook, tick, other]) await x.query('ROLLBACK').catch(() => {});
				await Promise.all([webhook.end(), tick.end(), other.end()]);
			}
			expect(await asOwner('SELECT status FROM subscription WHERE id = $1', [sub])).toEqual([{ status: 'expired' }]);
			expect(await asOwner(`SELECT action, reason, granted_by FROM billing_grant_log WHERE subscription_id = $1`, [sub])).toEqual([
				{ action: 'expire', reason: c.reason, granted_by: 'expiry' }
			]);
		});
	}
});

// The staff revoke (app_staff_revoke_grant, 330) had the same order until 401: it locked the grant's row FOR UPDATE
// and met the billing lock only in 341's sync on its UPDATE, so against a paid invoice's webhook (which holds the
// billing lock and locks the live grant's row FOR UPDATE, 344) the two deadlocked. It runs as the schema owner.
describe('the staff revoke takes the billing lock before the grant row (401)', () => {
	it('waits on the advisory lock holding no row lock, then revokes the grant', async () => {
		const u = await signUp('LockRevoke');
		const account = (await asOwner(`SELECT billing_account_ensure('user', $1) AS a`, [u.id]))[0]!.a as string;
		const sub = (
			await asOwner(
				`INSERT INTO subscription (billing_account_id, plan_code, status, provider, period_start, period_end, cancel_at_period_end)
				 VALUES ($1, 'pro', 'active', 'manual', now() - interval '2 days', now() + interval '20 days', true) RETURNING id`,
				[account]
			)
		)[0]!.id as string;
		const webhook = await connect(process.env.TEST_MIGRATION_DATABASE_URL);
		const operator = await connect(process.env.TEST_MIGRATION_DATABASE_URL);
		const other = await connect(process.env.TEST_MIGRATION_DATABASE_URL);
		try {
			await webhook.query('BEGIN');
			await webhook.query(`SELECT pg_advisory_xact_lock(hashtext('billing:' || $1::text))`, [account]);
			const pid = await pidOf(operator);
			await operator.query('BEGIN');
			const revoked = operator.query<{ id: string }>(`SELECT app_staff_revoke_grant($1, 'lock order', 'test') AS id`, [account]).then(
				(r) => r.rows[0]!.id,
				(e: { code?: string }) => `failed ${String(e.code)}`
			);
			expect(await waitingOn(pid)).toBe('advisory');
			await other.query('BEGIN');
			await expect(other.query('SELECT 1 FROM subscription WHERE id = $1 FOR UPDATE NOWAIT', [sub])).resolves.toMatchObject({ rowCount: 1 });
			await other.query('ROLLBACK');
			await webhook.query('COMMIT');
			expect(await revoked).toBe(sub);
			await operator.query('COMMIT');
		} finally {
			for (const x of [webhook, operator, other]) await x.query('ROLLBACK').catch(() => {});
			await Promise.all([webhook.end(), operator.end(), other.end()]);
		}
		expect(await asOwner('SELECT status FROM subscription WHERE id = $1', [sub])).toEqual([{ status: 'canceled' }]);
		expect(await asOwner(`SELECT action, reason, granted_by FROM billing_grant_log WHERE subscription_id = $1`, [sub])).toEqual([
			{ action: 'revoke', reason: 'lock order', granted_by: 'test' }
		]);
	});
});
