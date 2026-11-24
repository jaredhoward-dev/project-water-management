// The assistant's dollar caps and the paced Free pool, reserved before the turn
// (336_assistant_dollar_caps, issue #641; docs/billing.md § Assistant dollar caps):
//   - off (BILLING_ENFORCED unset, the default) nothing new refuses and the budget is 264's, though the dollars are
//     reserved and the day counted (shadow mode);
//   - on, each cap refuses past its limit (a Free person's day in dollars or messages, the account's month, a Team
//     member's share, the Free pool's month and its paced day), and the budget is cut to what the tightest has left;
//   - concurrent begins never reserve past a cap; a charge moves the dollars onto the day row; an expired
//     reservation is charged its dollars in full;
//   - a person reads only their own day rows (with a positive control).
// The workspace runs under a skewed TZ (CLAUDE.md rule 7); every boundary here is UTC, so the days and months are
// worked out by Postgres, and a row of yesterday or last month is shown not to count.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { poolDayAllowance } from './dollarCaps.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let editor: User;
let other: User;
let projectId: string;
let otherProject: string;
let account: string;
let otherAccount: string;

const PRICE = 2.5; // micro-USD a weighted token (Sonnet 5.5's dearest)
const MIN = 1_000; // tokens: a floor of 2 500 micro-USD
const MAX = 150_000;
const DAY_USD = 300_000;
const DAY_MSGS = 20;
const BIG_POOL = 1e15;

interface Begun {
	outcome: string;
	wait_seconds: number;
	budget: number | null;
	reserved_usd_micros: number | null;
	pool_used_usd_micros: number | null;
	reservation_id: string | null;
}

function begin(u: User, pid: string, opts: { pool?: number | null; price?: number | null } = {}): Promise<Begun> {
	return withUser(u.id, async (db) => {
		const { rows } = await db.query(
			`SELECT outcome, wait_seconds, budget::float8 AS budget, reserved_usd_micros::float8 AS reserved_usd_micros,
			        pool_used_usd_micros::float8 AS pool_used_usd_micros, reservation_id
			 FROM app_assistant_begin($1, 1000000000, 1000, 1000000000, 10000000000000, $2, $3, 300, $4, $5, $6, $7)`,
			[pid, MAX, MIN, opts.price === undefined ? PRICE : opts.price, DAY_USD, DAY_MSGS, opts.pool === undefined ? BIG_POOL : opts.pool]
		);
		return rows[0] as Begun;
	});
}
const utcDay = async (offset = 0) => (await asOwner(`SELECT ((now() AT TIME ZONE 'UTC')::date + $1::int)::text AS d`, [offset]))[0]!.d as string;
const utcMonth = async () => (await asOwner(`SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date::text AS m`))[0]!.m as string;
/** Record `usd` of spend this month on a project by a person, as a charge would. */
const spend = async (u: User, pid: string, usd: number, month?: string) =>
	asOwner(
		`INSERT INTO assistant_usage (project_id, user_id, month, cost_usd_micros) VALUES ($1, $2, $3, $4)
		 ON CONFLICT (project_id, month, user_id) DO UPDATE SET cost_usd_micros = assistant_usage.cost_usd_micros + EXCLUDED.cost_usd_micros`,
		[pid, u.id, month ?? (await utcMonth()), usd]
	);
const dayRow = async (u: User, acct: string, day: string, messages: number, usd = 0) =>
	asOwner(
		`INSERT INTO assistant_day_usage (billing_account_id, user_id, day, messages, cost_usd_micros) VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (billing_account_id, day, user_id) DO UPDATE SET messages = EXCLUDED.messages, cost_usd_micros = EXCLUDED.cost_usd_micros`,
		[acct, u.id, day, messages, usd]
	);
/** The pool's spend this month and today (every Free account in the test database, other files' too). */
const poolSpent = async () => {
	const r = (
		await asOwner(`SELECT pool_month::float8 AS m, pool_today::float8 AS t FROM assistant_dollars_spent($1::date, $2::date, NULL, NULL)`, [await utcMonth(), await utcDay()])
	)[0]!;
	return { month: Number(r.m), today: Number(r.t) };
};
const clear = async () => {
	const users = [owner, editor, other].map((u) => u.id);
	await asOwner('DELETE FROM assistant_reservation WHERE project_id = ANY($1)', [[projectId, otherProject]]);
	await asOwner('DELETE FROM assistant_usage WHERE project_id = ANY($1)', [[projectId, otherProject]]);
	await asOwner('DELETE FROM assistant_day_usage WHERE user_id = ANY($1)', [users]);
	await asOwner('DELETE FROM assistant_rate WHERE user_id = ANY($1)', [users]);
	await asOwner('DELETE FROM subscription WHERE billing_account_id = ANY($1)', [[account, otherAccount]]);
	await asOwner('UPDATE billing_account SET assistant_member_max_pct = 50 WHERE id = ANY($1)', [[account, otherAccount]]);
};

beforeAll(async () => {
	[owner, editor, other] = (await Promise.all(['Downer', 'Deditor', 'Dother'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Dollars' })).body.project.id;
	otherProject = (await other.call('POST', '/projects', { name: 'Dollars, other' })).body.project.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBeLessThan(300);
	const acc = async (pid: string) => ((await asOwner('SELECT billing_account_id AS a FROM project WHERE id = $1', [pid]))[0]!.a as string);
	account = await acc(projectId);
	otherAccount = await acc(otherProject);
	expect(account).toBeTruthy();
	expect(otherAccount).not.toBe(account);
});
beforeEach(clear);
afterEach(() => vi.unstubAllEnvs());
afterAll(clear);

const enforce = () => vi.stubEnv('BILLING_ENFORCED', 'true');

describe('off (the default): exactly 264, dollars only recorded', () => {
	it('never refuses a spent Free month, day or pool, and keeps the token budget', async () => {
		await spend(owner, projectId, 5_000_000);
		await dayRow(owner, account, await utcDay(), DAY_MSGS, DAY_USD);
		const r = await begin(owner, projectId, { pool: 1 });
		expect(r.outcome).toBe('ok');
		expect(r.budget).toBe(MAX);
		// Shadow mode: the reservation's dollars and the day's message are recorded.
		expect(r.reserved_usd_micros).toBe(MAX * PRICE);
		const [d] = await asOwner('SELECT messages FROM assistant_day_usage WHERE billing_account_id = $1 AND user_id = $2 AND day = $3', [account, owner.id, await utcDay()]);
		expect(d!.messages).toBe(DAY_MSGS + 1);
	});

	it('keeps the 8-argument begin a backend before 336 calls', async () => {
		enforce();
		const rows = await withUser(owner.id, (db) => db.query('SELECT outcome, budget::int AS budget FROM app_assistant_begin($1, 1000000, 30, 1000000, 100000000000, 20000, 1000, 300)', [projectId]));
		expect(rows.rows[0]).toEqual({ outcome: 'ok', budget: 20_000 });
	});
});

describe('on: each cap refuses past its limit', () => {
	it('a fresh Free person begins, the budget cut to what the day buys (positive control)', async () => {
		enforce();
		const r = await begin(owner, projectId);
		expect(r.outcome).toBe('ok');
		// $0.30 at 2.5 micro-USD a token: 120 000 tokens, below the turn's 150 000.
		expect(r.budget).toBe(DAY_USD / PRICE);
		expect(r.reserved_usd_micros).toBe(DAY_USD);
	});

	it('the Free day, in dollars and in messages, until UTC midnight; yesterday doesn’t count', async () => {
		enforce();
		await dayRow(owner, account, await utcDay(-1), DAY_MSGS, DAY_USD);
		expect((await begin(owner, projectId)).outcome).toBe('ok');
		await clear();
		enforce();
		await dayRow(owner, account, await utcDay(), DAY_MSGS, 0);
		const byMessages = await begin(owner, projectId);
		expect(byMessages.outcome).toBe('day');
		expect(byMessages.wait_seconds).toBeLessThanOrEqual(86_400);
		await dayRow(owner, account, await utcDay(), 0, DAY_USD - 2_000);
		expect((await begin(owner, projectId)).outcome).toBe('day');
		// Another person's Free day is their own.
		expect((await begin(other, otherProject)).outcome).toBe('ok');
	});

	it('the Free month ($1); last month doesn’t count', async () => {
		enforce();
		await spend(owner, projectId, 5_000_000, (await asOwner(`SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date::text AS m`))[0]!.m as string);
		expect((await begin(owner, projectId)).outcome).toBe('ok');
		await clear();
		enforce();
		await spend(owner, projectId, 1_000_000 - 2_000);
		const r = await begin(owner, projectId);
		expect(r.outcome).toBe('month');
		expect(r.wait_seconds).toBeGreaterThan(0);
	});

	it('Pro: $15 a month, no Free day', async () => {
		enforce();
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'active', 'manual')`, [account]);
		await dayRow(owner, account, await utcDay(), DAY_MSGS + 5, 5_000_000);
		// The day row's dollars are in the month too only through assistant_usage: $5 here.
		await spend(owner, projectId, 5_000_000);
		const ok = await begin(owner, projectId);
		expect(ok.outcome).toBe('ok');
		expect(ok.budget).toBe(MAX);
		await spend(owner, projectId, 10_000_000);
		expect((await begin(owner, projectId)).outcome).toBe('month');
	});

	it('Team: $15 a seat pooled, one person at most half unless raised', async () => {
		enforce();
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, seats, provider) VALUES ($1, 'team', 'active', 3, 'manual')`, [account]);
		// $45 pooled; the owner has used $22.50, half.
		await spend(owner, projectId, 22_500_000);
		expect((await begin(owner, projectId)).outcome).toBe('member');
		expect((await begin(editor, projectId)).outcome).toBe('ok');
		await asOwner('UPDATE billing_account SET assistant_member_max_pct = 80 WHERE id = $1', [account]);
		expect((await begin(owner, projectId)).outcome).toBe('ok');
		// The pool of the account binds everyone.
		await spend(editor, projectId, 22_500_000);
		expect((await begin(editor, projectId)).outcome).toBe('month');
	});

	it('the Free pool’s month', async () => {
		enforce();
		const base = await poolSpent();
		const r = await begin(owner, projectId, { pool: base.month + 1_000 });
		expect(r.outcome).toBe('pool');
		// A paid account doesn't draw on it.
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'active', 'manual')`, [account]);
		expect((await begin(owner, projectId, { pool: base.month + 1_000 })).outcome).toBe('ok');
	});

	it('the Free pool’s paced day: twice the even share of what the day started with', async () => {
		enforce();
		// $1 of today's pool spend on another Free account (its own month and day are far from full: the pool binds).
		await spend(other, otherProject, 200_000);
		await dayRow(other, otherAccount, await utcDay(), 1, 200_000);
		const base = await poolSpent();
		const daysLeft = Number((await asOwner(`SELECT ((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month')::date - (now() AT TIME ZONE 'UTC')::date) AS n`))[0]!.n);
		const before = base.month - base.today;
		// A pool whose share today is what has been spent today: nothing left for today.
		const pool = before + Math.floor((base.today * daysLeft) / 2);
		const r = await begin(owner, projectId, { pool });
		expect(r.outcome).toBe('pool');
		// A pool twice as large leaves room today.
		const bigger = before + base.today * daysLeft * 2;
		expect((await begin(owner, projectId, { pool: bigger })).outcome).toBe('ok');
	});

	it('a model with no price is refused only by a cap already spent', async () => {
		enforce();
		const r = await begin(owner, projectId, { price: null });
		expect(r).toMatchObject({ outcome: 'ok', budget: MAX, reserved_usd_micros: null });
		await dayRow(owner, account, await utcDay(), 1, DAY_USD);
		expect((await begin(owner, projectId, { price: null })).outcome).toBe('day');
	});
});

describe('reservations and charges', () => {
	it('concurrent begins never reserve past the Free day', async () => {
		enforce();
		const results = await Promise.all(Array.from({ length: 8 }, () => begin(owner, projectId)));
		const ok = results.filter((r) => r.outcome === 'ok');
		const reserved = ok.reduce((s, r) => s + Number(r.reserved_usd_micros), 0);
		expect(reserved).toBeLessThanOrEqual(DAY_USD);
		expect(ok.length).toBeGreaterThanOrEqual(1);
		expect(results.filter((r) => r.outcome === 'day').length).toBe(8 - ok.length);
	});

	it('a charge moves the turn’s dollars onto its day row, freeing the rest', async () => {
		enforce();
		const r = await begin(owner, projectId);
		await withUser(owner.id, (db) => db.query('SELECT * FROM app_assistant_charge($1, $2, 1000, 100, 0, 0, 4000)', [projectId, r.reservation_id]));
		const [d] = await asOwner('SELECT cost_usd_micros::int AS c FROM assistant_day_usage WHERE billing_account_id = $1 AND user_id = $2 AND day = $3', [account, owner.id, await utcDay()]);
		expect(d!.c).toBe(4_000);
		const next = await begin(owner, projectId);
		expect(next.budget).toBe(Math.floor((DAY_USD - 4_000) / PRICE));
	});

	it('an expired reservation is charged its dollars in full, not as an unpriced turn', async () => {
		const r = await begin(owner, projectId);
		await asOwner(`UPDATE assistant_reservation SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1`, [r.reservation_id]);
		await begin(owner, projectId);
		const [u] = await asOwner('SELECT cost_usd_micros::float8 AS c, unpriced_turns AS n FROM assistant_usage WHERE project_id = $1 AND user_id = $2', [projectId, owner.id]);
		expect(u).toEqual({ c: MAX * PRICE, n: 0 });
		const [d] = await asOwner('SELECT cost_usd_micros::float8 AS c FROM assistant_day_usage WHERE billing_account_id = $1 AND user_id = $2 AND day = $3', [account, owner.id, await utcDay()]);
		expect(d!.c).toBe(MAX * PRICE);
	});
});

describe('assistant_day_usage', () => {
	it('a person reads their own rows (positive control) and nobody else’s', async () => {
		await dayRow(owner, account, await utcDay(), 3);
		await dayRow(other, otherAccount, await utcDay(), 4);
		const mine = await withUser(owner.id, (db) => db.query('SELECT user_id, messages FROM assistant_day_usage'));
		expect(mine.rows).toEqual([{ user_id: owner.id, messages: 3 }]);
		await expect(withUser(owner.id, (db) => db.query('UPDATE assistant_day_usage SET messages = 0'))).rejects.toMatchObject({ code: '42501' });
	});

	it('is in the person’s Download my data (assistantDays)', async () => {
		await dayRow(owner, account, await utcDay(), 2, 1_500);
		const r = await owner.call('GET', '/auth/me/export');
		expect(r.status).toBe(200);
		expect(r.body.assistantDays).toEqual([expect.objectContaining({ billingAccountId: account, day: await utcDay(), messages: 2, costUsdMicros: 1_500 })]);
	});

	it('paces the pool as dollarCaps.ts poolDayAllowance does, at the month’s turns', async () => {
		for (const [day, spent] of [
			['2026-10-31', 0],
			['2026-11-01', 0],
			['2026-11-21', 27_000_000],
			['2026-11-30', 29_000_000],
			['2028-02-29', 1_234_567],
			['2026-11-10', 31_000_000]
		] as const) {
			const [r] = await asOwner('SELECT assistant_pool_day_allowance(30000000, $1, $2::date)::float8 AS a', [spent, day]);
			expect(r!.a, day).toBe(poolDayAllowance(30_000_000, spent, new Date(`${day}T12:00:00Z`)));
		}
	});
});
