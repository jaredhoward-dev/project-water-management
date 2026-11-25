// The assistant's dollar counters (361_assistant_month_counter; docs/billing.md § Assistant dollar caps, The
// counters): assistant_dollars_spent reads per-account and pool counters kept by triggers instead of summing every
// account's rows, and must answer exactly as 336's sum did. Each case here writes through the real paths (begin,
// charge, the expiry sweep, a subscription change, a project moving or being deleted, rows of last month and of
// yesterday's SAST day) and then checks two things:
//   - every counter row in the database equals a fresh sum of the rows it counts (and no fresh sum lacks its row);
//   - assistant_dollars_spent equals 336's statement (REFERENCE below, verbatim) for this month and today, the
//     month before, and yesterday's SAST day, for each account and person here and for the pool alone.
// The workspace runs under a skewed TZ (CLAUDE.md rule 7); every day and month is worked out by Postgres.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let editor: User;
let other: User;
let projectId: string;
let otherProject: string;
let account: string;
let otherAccount: string;

const PRICE = 2.5;

// 336's assistant_dollars_spent body, the sum the counters replace: the reference they must equal.
const REFERENCE = `
	WITH spend AS (
		SELECT p.billing_account_id AS account, u.user_id, u.cost_usd_micros AS usd, false AS today, 0::bigint AS msgs
			FROM assistant_usage u JOIN project p ON p.id = u.project_id
			WHERE u.month = $1::date AND u.cost_usd_micros > 0
		UNION ALL
		SELECT d.billing_account_id, d.user_id, d.cost_usd_micros, true, d.messages
			FROM assistant_day_usage d WHERE d.day = $2::date
		UNION ALL
		SELECT p.billing_account_id, r.user_id, coalesce(r.reserved_usd_micros, 0), false, 0
			FROM assistant_reservation r JOIN project p ON p.id = r.project_id
			WHERE r.month = $1::date
		UNION ALL
		SELECT p.billing_account_id, r.user_id, coalesce(r.reserved_usd_micros, 0), true, 0
			FROM assistant_reservation r JOIN project p ON p.id = r.project_id
			WHERE r.day = $2::date
	), pool AS (
		SELECT DISTINCT account FROM spend WHERE account IS NOT NULL AND assistant_pool_account(account)
	)
	SELECT
		coalesce(sum(s.usd) FILTER (WHERE NOT s.today AND s.account = $3::uuid), 0)::float8 AS account_month,
		coalesce(sum(s.usd) FILTER (WHERE NOT s.today AND s.account = $3::uuid AND s.user_id = $4::uuid), 0)::float8 AS member_month,
		coalesce(sum(s.usd) FILTER (WHERE s.today AND s.account = $3::uuid AND s.user_id = $4::uuid), 0)::float8 AS member_day,
		coalesce(sum(s.msgs) FILTER (WHERE s.today AND s.account = $3::uuid AND s.user_id = $4::uuid), 0)::float8 AS member_day_messages,
		coalesce(sum(s.usd) FILTER (WHERE NOT s.today AND s.account IN (SELECT account FROM pool)), 0)::float8 AS pool_month,
		coalesce(sum(s.usd) FILTER (WHERE s.today AND s.account IN (SELECT account FROM pool)), 0)::float8 AS pool_today
	FROM spend s`;
const COUNTED = `
	SELECT account_month::float8, member_month::float8, member_day::float8, member_day_messages::float8, pool_month::float8, pool_today::float8
	FROM assistant_dollars_spent($1::date, $2::date, $3::uuid, $4::uuid)`;

/** Counter rows that differ from a fresh sum of what they count, over the whole database. */
const drift = async () =>
	asOwner(`
		WITH fresh_month AS (
			SELECT p.billing_account_id AS a, u.month AS k, sum(u.cost_usd_micros) AS usd
			FROM assistant_usage u JOIN project p ON p.id = u.project_id
			WHERE p.billing_account_id IS NOT NULL GROUP BY 1, 2
		), pool_accounts AS (
			SELECT id FROM billing_account WHERE assistant_pool_account(id)
		), fresh_pool AS (
			SELECT 'month' AS period, k AS start, sum(usd) AS usd FROM fresh_month WHERE a IN (SELECT id FROM pool_accounts) GROUP BY k
			UNION ALL
			SELECT 'day', d.day, sum(d.cost_usd_micros) FROM assistant_day_usage d
			WHERE d.billing_account_id IN (SELECT id FROM pool_accounts) GROUP BY d.day
		)
		SELECT 'month' AS what, coalesce(f.a, c.billing_account_id)::text AS who, coalesce(f.k, c.month)::text AS k,
			coalesce(f.usd, 0)::float8 AS fresh, coalesce(c.cost_usd_micros, 0)::float8 AS counted
		FROM fresh_month f FULL JOIN assistant_month_counter c ON c.billing_account_id = f.a AND c.month = f.k
		WHERE coalesce(f.usd, 0) <> coalesce(c.cost_usd_micros, 0)
		UNION ALL
		SELECT 'pool', coalesce(f.period, c.period), coalesce(f.start, c.start)::text, coalesce(f.usd, 0)::float8, coalesce(c.cost_usd_micros, 0)::float8
		FROM fresh_pool f FULL JOIN assistant_pool_counter c ON c.period = f.period AND c.start = f.start
		WHERE coalesce(f.usd, 0) <> coalesce(c.cost_usd_micros, 0)`);

const sastDay = async (offset = 0) => (await asOwner(`SELECT (assistant_day_of(now()) + $1::int)::text AS d`, [offset]))[0]!.d as string;
const utcMonth = async (offset = 0) =>
	(await asOwner(`SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => $1::int))::date::text AS m`, [offset]))[0]!.m as string;

/** Counters equal fresh sums, and the read equals 336's, for every key this file writes. */
async function expectExact() {
	expect(await drift()).toEqual([]);
	const keys: [string, string][] = [
		[await utcMonth(), await sastDay()],
		[await utcMonth(-1), await sastDay()],
		[await utcMonth(), await sastDay(-1)],
	];
	for (const [month, day] of keys) {
		for (const acct of [account, otherAccount, null]) {
			for (const u of [owner, editor, other]) {
				const params = [month, day, acct, u.id];
				const [want] = await asOwner(REFERENCE, params);
				const [got] = await asOwner(COUNTED, params);
				expect({ month, day, acct, user: u.id, ...got }).toEqual({ month, day, acct, user: u.id, ...want });
			}
		}
	}
}

async function begin(u: User, pid: string) {
	return withUser(u.id, async (db) => {
		const { rows } = await db.query(
			`SELECT outcome, reservation_id, reserved_usd_micros::float8 AS usd
			 FROM app_assistant_begin($1, 1000000000, 1000, 1000000000, 10000000000000, 150000, 1000, 300, $2, 300000, 20, 1000000000000000)`,
			[pid, PRICE]
		);
		return rows[0] as { outcome: string; reservation_id: string; usd: number };
	});
}
const charge = (u: User, pid: string, reservation: string | null, usd: number) =>
	withUser(u.id, (db) => db.query('SELECT * FROM app_assistant_charge($1, $2, 1000, 100, 0, 0, $3)', [pid, reservation, usd]));
const spend = (u: User, pid: string, usd: number, month: string) =>
	asOwner(
		`INSERT INTO assistant_usage (project_id, user_id, month, cost_usd_micros) VALUES ($1, $2, $3, $4)
		 ON CONFLICT (project_id, month, user_id) DO UPDATE SET cost_usd_micros = assistant_usage.cost_usd_micros + EXCLUDED.cost_usd_micros`,
		[pid, u.id, month, usd]
	);
const dayRow = (u: User, acct: string, day: string, usd: number) =>
	asOwner(
		`INSERT INTO assistant_day_usage (billing_account_id, user_id, day, messages, cost_usd_micros) VALUES ($1, $2, $3, 1, $4)
		 ON CONFLICT (billing_account_id, day, user_id) DO UPDATE SET cost_usd_micros = assistant_day_usage.cost_usd_micros + EXCLUDED.cost_usd_micros`,
		[acct, u.id, day, usd]
	);
const monthCounter = async (acct: string) =>
	Number((await asOwner('SELECT coalesce(sum(cost_usd_micros), 0)::float8 AS c FROM assistant_month_counter WHERE billing_account_id = $1 AND month = $2', [acct, await utcMonth()]))[0]!.c);

const clear = async () => {
	const users = [owner, editor, other].map((u) => u.id);
	await asOwner('DELETE FROM assistant_reservation WHERE project_id = ANY($1)', [[projectId, otherProject]]);
	await asOwner('DELETE FROM assistant_usage WHERE project_id = ANY($1)', [[projectId, otherProject]]);
	await asOwner('DELETE FROM assistant_day_usage WHERE user_id = ANY($1)', [users]);
	await asOwner('DELETE FROM assistant_rate WHERE user_id = ANY($1)', [users]);
	await asOwner('DELETE FROM subscription WHERE billing_account_id = ANY($1)', [[account, otherAccount]]);
};

beforeAll(async () => {
	[owner, editor, other] = (await Promise.all(['Cowner', 'Ceditor', 'Cother'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Counters' })).body.project.id;
	otherProject = (await other.call('POST', '/projects', { name: 'Counters, other' })).body.project.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBeLessThan(300);
	const acc = async (pid: string) => (await asOwner('SELECT billing_account_id AS a FROM project WHERE id = $1', [pid]))[0]!.a as string;
	account = await acc(projectId);
	otherAccount = await acc(otherProject);
	expect(account).toBeTruthy();
	expect(otherAccount).not.toBe(account);
});
beforeEach(clear);
afterAll(clear);

describe('the counters equal a fresh sum, and the read equals 336’s', () => {
	it('a recorded month’s spend lands on its account’s counter (positive control)', async () => {
		await spend(owner, projectId, 70_000, await utcMonth());
		expect(await monthCounter(account)).toBe(70_000);
		const [got] = await asOwner(COUNTED, [await utcMonth(), await sastDay(), account, owner.id]);
		expect(got!.account_month).toBe(70_000);
		expect(got!.member_month).toBe(70_000);
		await expectExact();
	});

	it('the counters are owner only: water_app holds no privilege on them, and RLS is on', async () => {
		const tables = ['assistant_month_counter', 'assistant_pool_counter', 'assistant_pool_member'];
		for (const t of tables) {
			const [r] = await asOwner(
				`SELECT has_table_privilege('water_app', $1, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS any,
					(SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass) AS rls`,
				[`public.${t}`]
			);
			expect([t, r!.any, r!.rls]).toEqual([t, false, true]);
		}
		// Positive control: the same check finds water_app's privilege on a table it does write.
		const [ok] = await asOwner(`SELECT has_table_privilege('water_app', 'public.assistant_day_usage', 'SELECT, INSERT, UPDATE, DELETE') AS any`);
		expect(ok!.any).toBe(true);
	});

	it('begin, then charge: the reservation’s dollars move onto the usage and day rows', async () => {
		const r = await begin(owner, projectId);
		expect(r.outcome).toBe('ok');
		await expectExact();
		await charge(owner, projectId, r.reservation_id, 4_000);
		expect(await monthCounter(account)).toBe(4_000);
		await expectExact();
		// A charge with no reservation (today, this month), and another person's on the same account.
		await charge(owner, projectId, null, 1_500);
		const e = await begin(editor, projectId);
		await charge(editor, projectId, e.reservation_id, 2_000);
		expect(await monthCounter(account)).toBe(7_500);
		await expectExact();
	});

	it('a released reservation (charged less, or nothing) and an expired one charged in full', async () => {
		const a = await begin(owner, projectId);
		await charge(owner, projectId, a.reservation_id, 0);
		await expectExact();
		const b = await begin(other, otherProject);
		await asOwner(`UPDATE assistant_reservation SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1`, [b.reservation_id]);
		// The next begin settles it: its dollars land on usage and the day row in full.
		await begin(owner, projectId);
		expect(await monthCounter(otherAccount)).toBe(b.usd);
		await expectExact();
	});

	it('last month and yesterday’s SAST day count only where they belong', async () => {
		await spend(owner, projectId, 9_000, await utcMonth(-1));
		await dayRow(owner, account, await sastDay(-1), 8_000);
		await spend(owner, projectId, 1_000, await utcMonth());
		await dayRow(owner, account, await sastDay(), 1_000);
		expect(await monthCounter(account)).toBe(1_000);
		const [today] = await asOwner(COUNTED, [await utcMonth(), await sastDay(), account, owner.id]);
		expect(today!.member_day).toBe(1_000);
		await expectExact();
	});

	it('a subscription moves the account’s spend out of the pool, and back when it lapses', async () => {
		await spend(owner, projectId, 50_000, await utcMonth());
		await dayRow(owner, account, await sastDay(), 50_000);
		const pool = async () => (await asOwner(COUNTED, [await utcMonth(), await sastDay(), null, owner.id]))[0]!;
		const before = await pool();
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'active', 'manual')`, [account]);
		const paid = await pool();
		expect(paid.pool_month).toBe(before.pool_month - 50_000);
		expect(paid.pool_today).toBe(before.pool_today - 50_000);
		await expectExact();
		// Spend while paid stays out of the pool.
		await spend(owner, projectId, 5_000, await utcMonth());
		await expectExact();
		await asOwner(`UPDATE subscription SET status = 'canceled' WHERE billing_account_id = $1 AND status = 'active'`, [account]);
		expect((await pool()).pool_month).toBe(before.pool_month + 5_000);
		await expectExact();
		// A trial is in the pool, as Free is.
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'trialing', 'manual')`, [account]);
		expect((await pool()).pool_month).toBe(before.pool_month + 5_000);
		await expectExact();
	});

	it('a project moving account takes its month with it; a deleted project’s goes', async () => {
		const pid = (await owner.call('POST', '/projects', { name: 'Counters, moving' })).body.project.id as string;
		await spend(owner, pid, 3_000, await utcMonth());
		await spend(owner, pid, 2_000, await utcMonth(-1));
		const base = await monthCounter(otherAccount);
		await asOwner('UPDATE project SET billing_account_id = $2 WHERE id = $1', [pid, otherAccount]);
		expect(await monthCounter(otherAccount)).toBe(base + 3_000);
		await expectExact();
		await asOwner('UPDATE project SET billing_account_id = NULL WHERE id = $1', [pid]);
		expect(await monthCounter(otherAccount)).toBe(base);
		await expectExact();
		await asOwner('UPDATE project SET billing_account_id = $2 WHERE id = $1', [pid, account]);
		await expectExact();
		expect((await owner.call('DELETE', `/projects/${pid}`)).status).toBeLessThan(300);
		await expectExact();
	});

	it('a usage row moved to last month is counted there; a costed day row never moves', async () => {
		await spend(owner, projectId, 1_000, await utcMonth());
		await asOwner('UPDATE assistant_usage SET month = $2 WHERE project_id = $1', [projectId, await utcMonth(-1)]);
		expect(await monthCounter(account)).toBe(0);
		await expectExact();
		await dayRow(owner, account, await sastDay(), 1_000);
		await expect(
			asOwner('UPDATE assistant_day_usage SET day = day - 1 WHERE billing_account_id = $1 AND user_id = $2', [account, owner.id])
		).rejects.toThrow(/never moves/);
	});
});

describe('concurrent writers never deadlock on the shared pool counter', () => {
	/** An owner connection with a transaction open. */
	const open = async () => {
		const c = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await c.connect();
		await c.query('BEGIN');
		return c;
	};
	const spendOn = (c: pg.Client, u: User, pid: string, usd: number, month: string) =>
		c.query(
			`INSERT INTO assistant_usage (project_id, user_id, month, cost_usd_micros) VALUES ($1, $2, $3, $4)
			 ON CONFLICT (project_id, month, user_id) DO UPDATE SET cost_usd_micros = assistant_usage.cost_usd_micros + EXCLUDED.cost_usd_micros`,
			[pid, u.id, month, usd]
		);
	/** Whether the connection's backend is waiting on a lock. */
	const waiting = async (c: pg.Client) => {
		const pid = (c as unknown as { processID: number }).processID;
		for (let i = 0; i < 200; i++) {
			const [r] = await asOwner(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
			if (r?.wait_event_type === 'Lock') return true;
			await new Promise((res) => setTimeout(res, 25));
		}
		return false;
	};

	it('two pool accounts writing this month and last in opposite orders both commit, exactly (positive control: both are in the pool)', async () => {
		const [now, prev] = [await utcMonth(), await utcMonth(-1)];
		const a = await open();
		const b = await open();
		try {
			// A: this month, then last. B: last month, then this. Under per-account locks alone, each would
			// hold one shared pool row and wait for the other's: a deadlock Postgres breaks by failing one.
			await spendOn(a, owner, projectId, 1_000, now);
			const bFirst = spendOn(b, other, otherProject, 2_000, prev);
			// B waits for A's counter lock before it touches any pool row.
			expect(await waiting(b)).toBe(true);
			await spendOn(a, owner, projectId, 3_000, prev);
			await a.query('COMMIT');
			await bFirst;
			await spendOn(b, other, otherProject, 4_000, now);
			await b.query('COMMIT');
		} finally {
			await a.query('ROLLBACK').catch(() => {});
			await b.query('ROLLBACK').catch(() => {});
			await Promise.all([a.end(), b.end()]);
		}
		const members = await asOwner('SELECT billing_account_id::text AS a FROM assistant_pool_member WHERE billing_account_id = ANY($1)', [[account, otherAccount]]);
		expect(members.map((m) => m.a).sort()).toEqual([account, otherAccount].sort());
		expect(await monthCounter(account)).toBe(1_000);
		expect(await monthCounter(otherAccount)).toBe(4_000);
		await expectExact();
	});
});
