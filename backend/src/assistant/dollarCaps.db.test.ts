// The assistant's dollar caps and the paced Free pool, reserved before the turn
// (336_assistant_dollar_caps, 337_assistant_sast_day, issue #641; docs/billing.md § Assistant dollar caps):
//   - off (BILLING_ENFORCED unset, the default) nothing new refuses and the budget is 264's, though the dollars are
//     reserved and the day counted (shadow mode);
//   - on, each cap refuses past its limit (a Free person's day in dollars or messages, the account's month, a Team
//     member's share, the Free pool's month and its paced day), and the budget is cut to what the tightest has left;
//   - concurrent begins never reserve past a cap; a charge moves the dollars onto the day row; an expired
//     reservation is charged its dollars in full;
//   - a person reads only their own day rows (with a positive control);
//   - through the route, each refusal is 429 with its code, the issue's words, Retry-After, params.seconds and
//     params.resetsAt (Retry-After from now); a pool account's turn logs `assistant_free_pool` at 50% and 80% of the
//     pool's month, and not below;
//   - the day meter (350_assistant_day_meter, 351's own median): what a Free person has left today, and the median
//     of their own questions (never another member's), only enforced, only to a member, only on a capped account.
// The workspace runs under a skewed TZ (CLAUDE.md rule 7); the Free day is the SAST day (00:00 SAST, 22:00 UTC) and
// every month is UTC, so the days and months are worked out by Postgres, and a row of yesterday or last month is
// shown not to count.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { dayResetsAt, DOLLAR_REFUSAL, poolDayAllowance, type DollarOutcome } from './dollarCaps.js';
import { dayMeter } from './usage.js';

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
/** The SAST day the Free day is keyed on (337), `offset` days from today's. */
const sastDay = async (offset = 0) => (await asOwner(`SELECT ((now() AT TIME ZONE 'Africa/Johannesburg')::date + $1::int)::text AS d`, [offset]))[0]!.d as string;
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
		await asOwner(`SELECT pool_month::float8 AS m, pool_today::float8 AS t FROM assistant_dollars_spent($1::date, $2::date, NULL, NULL)`, [await utcMonth(), await sastDay()])
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
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
afterAll(clear);

const enforce = () => vi.stubEnv('BILLING_ENFORCED', 'true');

describe('off (the default): exactly 264, dollars only recorded', () => {
	it('never refuses a spent Free month, day or pool, and keeps the token budget', async () => {
		await spend(owner, projectId, 5_000_000);
		await dayRow(owner, account, await sastDay(), DAY_MSGS, DAY_USD);
		const r = await begin(owner, projectId, { pool: 1 });
		expect(r.outcome).toBe('ok');
		expect(r.budget).toBe(MAX);
		// Shadow mode: the reservation's dollars and the day's message are recorded.
		expect(r.reserved_usd_micros).toBe(MAX * PRICE);
		const [d] = await asOwner('SELECT messages FROM assistant_day_usage WHERE billing_account_id = $1 AND user_id = $2 AND day = $3', [account, owner.id, await sastDay()]);
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

	it('the Free day, in dollars and in messages, until 00:00 SAST; yesterday doesn’t count', async () => {
		enforce();
		await dayRow(owner, account, await sastDay(-1), DAY_MSGS, DAY_USD);
		expect((await begin(owner, projectId)).outcome).toBe('ok');
		await clear();
		enforce();
		await dayRow(owner, account, await sastDay(), DAY_MSGS, 0);
		const byMessages = await begin(owner, projectId);
		expect(byMessages.outcome).toBe('day');
		expect(byMessages.wait_seconds).toBeLessThanOrEqual(86_400);
		// The wait ends at the next 00:00 SAST, 22:00 UTC.
		expect(Math.abs(Date.now() + byMessages.wait_seconds * 1000 - Date.parse(dayResetsAt()))).toBeLessThan(60_000);
		expect(new Date(Date.now() + byMessages.wait_seconds * 1000 + 30_000).getUTCHours()).toBe(22);
		await dayRow(owner, account, await sastDay(), 0, DAY_USD - 2_000);
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
		await dayRow(owner, account, await sastDay(), DAY_MSGS + 5, 5_000_000);
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
		await dayRow(other, otherAccount, await sastDay(), 1, 200_000);
		const base = await poolSpent();
		// SAST days left in the UTC month, at least 1, as 337's allowance counts them: a UTC day here made the pool a
		// day's share too big from 22:00 to 24:00 UTC (the SAST day already tomorrow), and the begin went through.
		const daysLeft = Number(
			(await asOwner(`SELECT greatest(1, (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month')::date - assistant_day_of(now())) AS n`))[0]!.n
		);
		// The begin floors the month's spend before today at 0 (from 00:00 to 02:00 UTC on the 1st, today holds last month's 2 hours).
		const before = Math.max(0, base.month - base.today);
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
		await dayRow(owner, account, await sastDay(), 1, DAY_USD);
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
		const [d] = await asOwner('SELECT cost_usd_micros::int AS c FROM assistant_day_usage WHERE billing_account_id = $1 AND user_id = $2 AND day = $3', [account, owner.id, await sastDay()]);
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
		const [d] = await asOwner('SELECT cost_usd_micros::float8 AS c FROM assistant_day_usage WHERE billing_account_id = $1 AND user_id = $2 AND day = $3', [account, owner.id, await sastDay()]);
		expect(d!.c).toBe(MAX * PRICE);
	});
});

describe('assistant_day_usage', () => {
	it('a person reads their own rows (positive control) and nobody else’s', async () => {
		await dayRow(owner, account, await sastDay(), 3);
		await dayRow(other, otherAccount, await sastDay(), 4);
		const mine = await withUser(owner.id, (db) => db.query('SELECT user_id, messages FROM assistant_day_usage'));
		expect(mine.rows).toEqual([{ user_id: owner.id, messages: 3 }]);
		await expect(withUser(owner.id, (db) => db.query('UPDATE assistant_day_usage SET messages = 0'))).rejects.toMatchObject({ code: '42501' });
	});

	it('is in the person’s Download my data (assistantDays)', async () => {
		await dayRow(owner, account, await sastDay(), 2, 1_500);
		const r = await owner.call('GET', '/auth/me/export');
		expect(r.status).toBe(200);
		expect(r.body.assistantDays).toEqual([expect.objectContaining({ billingAccountId: account, day: await sastDay(), messages: 2, costUsdMicros: 1_500 })]);
	});

	it('paces the pool as dollarCaps.ts poolDayAllowance does, at the SAST day’s and the UTC month’s turns', async () => {
		for (const [at, spent] of [
			['2026-10-30T21:59:59Z', 0],
			['2026-10-30T22:00:00Z', 0],
			['2026-10-31T23:59:59Z', 0], // already 1 November in South Africa, still October's pool
			['2026-11-01T00:00:00Z', 0],
			['2026-11-21T08:00:00Z', 27_000_000],
			['2026-11-30T12:00:00Z', 29_000_000],
			['2026-11-30T22:30:00Z', 29_000_000],
			['2028-02-28T22:00:00Z', 1_234_567], // the 29th of a leap February in South Africa
			['2026-11-10T00:00:00Z', 31_000_000]
		] as const) {
			const [r] = await asOwner(
				`SELECT assistant_pool_day_allowance(30000000, $1, assistant_day_of($2::timestamptz), date_trunc('month', $2::timestamptz AT TIME ZONE 'UTC')::date)::float8 AS a`,
				[spent, at]
			);
			expect(r!.a, at).toBe(poolDayAllowance(30_000_000, spent, new Date(at)));
		}
	});

	it('at the month’s turn, reads the pool’s spend as the begin does: the SAST day’s rows, the UTC month’s, before today floored at 0', async () => {
		// Far-future dates, so no other test's pool spend shares them. The other (Free) account spent $0.40 on
		// earlier days of November 2031, then $0.15 from 22:00 UTC on 30 November: SAST 1 December's row, November's usage.
		await spend(other, otherProject, 400_000, '2031-11-01');
		await spend(other, otherProject, 150_000, '2031-11-01');
		await dayRow(other, otherAccount, '2031-12-01', 1, 150_000);
		const POOL = 30_000_000;
		// The begin's sum (337): the allowance of (month's pool spend − today's, floored at 0) for the SAST day in the UTC month.
		const atInstant = async (at: string) =>
			(
				await asOwner(
					`SELECT s.pool_month::float8 AS m, s.pool_today::float8 AS t,
					        assistant_pool_day_allowance($1, greatest(0, s.pool_month - s.pool_today), assistant_day_of($2::timestamptz),
					                                     date_trunc('month', $2::timestamptz AT TIME ZONE 'UTC')::date)::float8 AS a
					 FROM assistant_dollars_spent(date_trunc('month', $2::timestamptz AT TIME ZONE 'UTC')::date, assistant_day_of($2::timestamptz), NULL, NULL) s`,
					[POOL, at]
				)
			)[0]! as { m: number; t: number; a: number };

		// 22:30 UTC on the UTC month's last day: already 1 December in South Africa, still November's pool, 1 day left.
		const late = await atInstant('2031-11-30T22:30:00Z');
		expect(late).toMatchObject({ m: 550_000, t: 150_000 });
		expect(late.a).toBe(poolDayAllowance(POOL, 400_000, new Date('2031-11-30T22:30:00Z')));
		expect(late.a).toBe((POOL - 400_000) * 2);

		// 01:00 UTC on the 1st: December's pool has no spend, but today's row holds the 2 hours before it. Before today
		// counts as 0 (never negative, which would grow the share), over December's 31 SAST days.
		const early = await atInstant('2031-12-01T01:00:00Z');
		expect(early).toMatchObject({ m: 0, t: 150_000 });
		expect(early.a).toBe(poolDayAllowance(POOL, 0, new Date('2031-12-01T01:00:00Z')));
		expect(early.a).toBe(Math.floor((POOL / 31) * 2));
	});

	it('keys the day on SAST whatever the session’s time zone: it turns over at 22:00 UTC', async () => {
		// The session in a zone 14 hours ahead of UTC first (the subquery runs before the row's functions).
		const [r] = await asOwner(
			`SELECT assistant_day_of('2026-11-10T21:59:59Z')::text AS before, assistant_day_of('2026-11-10T22:00:00Z')::text AS after
			 FROM (SELECT set_config('TimeZone', 'Pacific/Kiritimati', false)) s`
		);
		expect(r).toEqual({ before: '2026-11-10', after: '2026-11-11' });
	});

	it('a begin records the SAST day on the day row and the reservation', async () => {
		const r = await begin(owner, projectId);
		expect(r.outcome).toBe('ok');
		const today = await sastDay();
		const [res] = await asOwner('SELECT day::text AS day FROM assistant_reservation WHERE id = $1', [r.reservation_id]);
		expect(res!.day).toBe(today);
		const [d] = await asOwner('SELECT messages FROM assistant_day_usage WHERE billing_account_id = $1 AND user_id = $2 AND day = $3', [account, owner.id, today]);
		expect(d!.messages).toBe(1);
	});
});

describe('the day meter (350): what a capped person has left today', () => {
	const meter = (u: User, pid: string) => withUser(u.id, (db) => dayMeter(db, pid, { freeUsdMicrosPerDay: DAY_USD, freeMessagesPerDay: DAY_MSGS }));

	it('is null with billing off (the default): no cap refuses, so nothing counts down', async () => {
		expect(await meter(owner, projectId)).toBeNull();
	});

	it('a fresh Free person has the whole day and no median yet (positive control)', async () => {
		enforce();
		expect(await meter(owner, projectId)).toEqual({
			kind: 'free',
			usdMicrosPerDay: DAY_USD,
			usdMicrosLeft: DAY_USD,
			messagesLeft: DAY_MSGS,
			trialUsdMicrosLeft: null,
			medianTurnUsdMicros: null,
			resetsAt: dayResetsAt()
		});
	});

	it('counts today’s spend, messages and running turns; the median is the caller’s own last 30 days on the account', async () => {
		enforce();
		await dayRow(owner, account, await sastDay(), 4, 80_000); // 20 000 a question
		await dayRow(owner, account, await sastDay(-1), 2, 60_000); // 30 000
		await dayRow(editor, account, await sastDay(-3), 1, 10_000); // 10 000: another member of the same account
		await dayRow(owner, account, await sastDay(-40), 1, 5_000_000); // too old
		await dayRow(owner, account, await sastDay(-2), 3, 0); // unpriced: not a cost
		await dayRow(other, otherAccount, await sastDay(), 1, 290_000); // another account
		const m = await meter(owner, projectId);
		// The median of 20 000 and 30 000: the editor's 10 000 would have made it 20 000 (351).
		expect(m).toMatchObject({ kind: 'free', usdMicrosLeft: DAY_USD - 80_000, messagesLeft: DAY_MSGS - 4, medianTurnUsdMicros: 25_000 });
		// A running turn's reservation counts as spent, as the begin counts it: the begin cut it to what was left.
		expect((await begin(owner, projectId)).outcome).toBe('ok');
		expect(await meter(owner, projectId)).toMatchObject({ usdMicrosLeft: 0, messagesLeft: DAY_MSGS - 5 });
		// Yesterday's spend doesn't count against today.
		expect((await meter(editor, projectId))?.usdMicrosLeft).toBe(DAY_USD);
	});

	it('the median is the caller’s own questions: another member’s costlier days never move it, their own do (351)', async () => {
		enforce();
		// Another member's dear days on the same account: the owner, with no priced day of their own, has no median.
		for (const d of [-1, -2, -3]) await dayRow(editor, account, await sastDay(d), 1, 250_000);
		await dayRow(owner, account, await sastDay(-4), 5, 0); // the owner's questions, unpriced: still no cost to take
		expect((await meter(owner, projectId))?.medianTurnUsdMicros).toBeNull();
		// Positive control: the editor's own history is theirs to read.
		expect((await meter(editor, projectId))?.medianTurnUsdMicros).toBe(250_000);
		// The owner's own priced days move theirs, and the editor's still don't.
		await dayRow(owner, account, await sastDay(-1), 3, 30_000); // 10 000 a question
		expect((await meter(owner, projectId))?.medianTurnUsdMicros).toBe(10_000);
		await dayRow(owner, account, await sastDay(-2), 1, 40_001); // 40 001: the median of the two, rounded up
		expect((await meter(owner, projectId))?.medianTurnUsdMicros).toBe(25_001);
		expect((await meter(editor, projectId))?.medianTurnUsdMicros).toBe(250_000);
	});

	it('is null on a paid plan and for a stranger, but answers each member of a Free project', async () => {
		enforce();
		expect(await meter(editor, projectId)).not.toBeNull();
		expect(await meter(other, projectId)).toBeNull();
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'active', 'manual')`, [account]);
		expect(await meter(owner, projectId)).toBeNull();
	});

	it('is the status’s `day`, through the route (enforced), and null there for a paid plan', async () => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		enforce();
		const res = await owner.call('GET', `/projects/${projectId}/assistant`);
		expect(res.status).toBe(200);
		expect(res.body.day).toMatchObject({ kind: 'free', usdMicrosLeft: DAY_USD, messagesLeft: DAY_MSGS, resetsAt: dayResetsAt() });
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'active', 'manual')`, [account]);
		expect((await owner.call('GET', `/projects/${projectId}/assistant`)).body.day).toBeNull();
	});
});

/** One turn through the route, as the panel sends it (the mock provider: priced at 0, so only a cap already past its limit refuses). */
function post(u: User, pid: string) {
	return app.request(`/projects/${pid}/assistant/messages`, {
		method: 'POST',
		headers: { cookie: u.cookie, origin: 'http://localhost:7777', 'content-type': 'application/json' },
		body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
	});
}

/** The 429 a dollar cap answers: its code, words, Retry-After, params.seconds and params.resetsAt agreeing. */
async function expectRefusal(res: Response, outcome: DollarOutcome, waitTo: 'day' | 'month') {
	const sent = Date.now();
	expect(res.status).toBe(429);
	const body = (await res.json()) as { error: string; code: string; params: { seconds: number; resetsAt: string } };
	expect(body.code).toBe(DOLLAR_REFUSAL[outcome].code);
	const wait = Number(res.headers.get('retry-after'));
	expect(wait).toBe(body.params.seconds);
	expect(body.error).toBe(DOLLAR_REFUSAL[outcome].message(body.params.resetsAt));
	// resetsAt is the next 00:00 SAST, 22:00 UTC (the day, a pool day) or the next UTC month (the month, a member's share, a pool month).
	const now = new Date(sent);
	const boundary = waitTo === 'day' ? Date.parse(dayResetsAt(now)) : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
	expect(Math.abs(Date.parse(body.params.resetsAt) - boundary)).toBeLessThan(60_000);
	expect(Math.abs(sent + wait * 1000 - boundary)).toBeLessThan(60_000);
	// Nothing counted: no reservation left by the refusal.
	expect(await asOwner('SELECT 1 FROM assistant_reservation WHERE project_id = ANY($1)', [[projectId, otherProject]])).toEqual([]);
}

describe('through the route (enforced): 429, the code, Retry-After, params.seconds and params.resetsAt', () => {
	beforeEach(() => {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		enforce();
	});

	it('a fresh Free person’s turn streams (positive control)', async () => {
		expect((await post(owner, projectId)).status).toBe(200);
	});

	it('assistant_daily_cap, until 00:00 SAST', async () => {
		await dayRow(owner, account, await sastDay(), DAY_MSGS);
		await expectRefusal(await post(owner, projectId), 'day', 'day');
	});

	it('assistant_monthly_cap, until the UTC month ends', async () => {
		await spend(owner, projectId, 1_000_001);
		await expectRefusal(await post(owner, projectId), 'month', 'month');
	});

	it('assistant_member_cap, until the month ends; another member still chats', async () => {
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, seats, provider) VALUES ($1, 'team', 'active', 3, 'manual')`, [account]);
		await spend(owner, projectId, 22_500_001);
		await expectRefusal(await post(owner, projectId), 'member', 'month');
		expect((await post(editor, projectId)).status).toBe(200);
	});

	it('assistant_free_pool_spent, until the month ends once the pool’s month is spent, with no upgrade prompt', async () => {
		// Free spend on this account under its own $1 month and day; a pool smaller than the pool's month so far.
		await spend(owner, projectId, 500_000);
		const base = await poolSpent();
		vi.stubEnv('ASSISTANT_FREE_POOL_USD_PER_MONTH', String((base.month - 1) / 1e6));
		const res = await post(owner, projectId);
		await expectRefusal(res.clone(), 'pool', 'month');
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain('This isn’t something you did');
		expect(body.error).not.toMatch(/Pro|plan|upgrade/i);
	});
});

describe('the Free pool’s alarm line (shadow mode: logged with enforcement off too)', () => {
	/** The `assistant_free_pool` lines one turn logs, with the pool set so the month so far is `pct`% of it. */
	async function poolLines(pct: number) {
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		// Spend in the pool on another Free account, so the pool's month is never 0.
		await spend(other, otherProject, 500_000);
		const base = await poolSpent();
		expect(base.month).toBeGreaterThan(0);
		vi.stubEnv('ASSISTANT_FREE_POOL_USD_PER_MONTH', String(base.month / (pct / 100) / 1e6));
		const warn = vi.spyOn(console, 'warn');
		const res = await post(owner, projectId);
		expect(res.status).toBe(200);
		await res.text();
		const lines = warn.mock.calls
			.map((c) => (typeof c[0] === 'string' ? (JSON.parse(c[0]) as Record<string, unknown>) : (c[0] as Record<string, unknown>)))
			.filter((l) => l.event === 'assistant_free_pool');
		warn.mockRestore();
		return { lines, base };
	}

	it('is not logged below 50%', async () => {
		expect((await poolLines(40)).lines).toEqual([]);
	});

	it('is logged at 50%, amounts only', async () => {
		const { lines, base } = await poolLines(60);
		expect(lines).toEqual([{ event: 'assistant_free_pool', share: 50, usedUsdMicros: base.month, poolUsdMicros: expect.any(Number) }]);
		expect(base.month / (lines[0]!.poolUsdMicros as number)).toBeCloseTo(0.6, 3);
	});

	it('is logged at 80%', async () => {
		expect((await poolLines(85)).lines).toEqual([expect.objectContaining({ event: 'assistant_free_pool', share: 80 })]);
	});

	it('is not logged for a paid account’s turn (it doesn’t draw on the pool)', async () => {
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'active', 'manual')`, [account]);
		expect((await poolLines(85)).lines).toEqual([]);
	});
});
