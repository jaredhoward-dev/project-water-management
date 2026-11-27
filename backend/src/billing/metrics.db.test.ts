// 325_billing_metrics's owner-only functions (issue #641 Phase 1 metrics), on synthetic rows in March 2001, a month no
// other test writes to:
//  - the month's edges are SAST's, whatever the session's time zone: a sign-up or run at 00:30 SAST on the 1st is in the
//    month, one at 00:30 SAST on the 1st of the next isn't (CLAUDE.md rule 7);
//  - per account: the month's runs, reports (usage_counter) and assistant spend (assistant_usage), and the plan (Free);
//  - per person: verified, first run, the SAST sign-up day; and the report built from them;
//  - water_app can neither execute nor call either function; the owner can (positive control).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { APP_URL, OWNER_URL } from '../__tests__/test-db.js';
import { gatherReport } from '../../scripts/billing-report.js';

type User = Awaited<ReturnType<typeof signUp>>;
let early: User; // signs up 2001-03-01 00:30 SAST (2001-02-28 22:30 UTC): in March
let late: User; // signs up 2001-04-01 00:30 SAST (2001-03-31 22:30 UTC): not in March
let account: string;
let projectId: string;

const MONTH = '2001-03-01';
const ZONES = ['UTC', 'Pacific/Kiritimati', 'America/Adak', 'Africa/Johannesburg'];

beforeAll(async () => {
	[early, late] = (await Promise.all(['MetricsEarly', 'MetricsLate'].map((n) => signUp(n)))) as [User, User];
	projectId = (await early.call('POST', '/projects', { name: 'Metrics synthetic' })).body.project.id;
	account = ((await asOwner('SELECT billing_account_id AS id FROM project WHERE id = $1', [projectId])) as { id: string }[])[0]!.id;
	await asOwner(`UPDATE app_user SET created_at = '2001-02-28T22:30:00Z' WHERE id = $1`, [early.id]);
	await asOwner(`UPDATE app_user SET created_at = '2001-03-31T22:30:00Z' WHERE id = $1`, [late.id]);
	// Runs: one at 00:30 SAST on 1 March (in), one at 00:30 SAST on 1 April (out), one in mid-March (in).
	for (const at of ['2001-02-28T22:30:00Z', '2001-03-31T22:30:00Z', '2001-03-15T10:00:00Z'])
		await asOwner(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, created_at)
			 VALUES ($1, $2, '1.0.0', '2000-10-01', '2001-09-30', '{}', $3)`,
			[projectId, early.id, at]
		);
	await asOwner(`INSERT INTO usage_counter (billing_account_id, kind, month, qty) VALUES ($1, 'reports', $2, 4), ($1, 'reports', '2001-04-01', 9)`, [account, MONTH]);
	await asOwner(
		`INSERT INTO assistant_usage (project_id, user_id, month, cost_usd_micros, unpriced_turns, updated_at)
		 VALUES ($1, $2, $3, 900000, 1, '2001-03-03T12:00:00Z'), ($1, NULL, '2001-04-01', 5000000, 0, '2001-04-02T12:00:00Z')`,
		[projectId, early.id, MONTH]
	);
});

afterAll(async () => {
	await asOwner('DELETE FROM usage_counter WHERE billing_account_id = $1', [account]);
	await asOwner(`DELETE FROM email_gate_refusal WHERE day IN ('2001-03-01', '2001-03-31', '2001-04-01')`);
});

const inZone = async <T extends pg.QueryResultRow>(tz: string, sql: string, params: unknown[]) => {
	const client = new pg.Client({ connectionString: OWNER_URL });
	await client.connect();
	try {
		await client.query(`SET TIME ZONE '${tz}'`);
		return (await client.query<T>(sql, params)).rows;
	} finally {
		await client.end();
	}
};

describe('billing_metrics_accounts', () => {
	it('counts the SAST month’s runs and reports and the month’s assistant spend, in any session time zone', async () => {
		for (const tz of ZONES) {
			const rows = await inZone(tz, 'SELECT * FROM billing_metrics_accounts($1::date) WHERE account_id = $2', [MONTH, account]);
			expect(rows.map((r) => ({ ...r, last_spend_at: (r.last_spend_at as Date).toISOString() })), tz).toEqual([
				{
					account_id: account, kind: 'user', plan_code: 'free', started_at: new Date('2001-02-28T22:30:00Z'), catchments: '1', runs: '2', reports: '4',
					assistant_usd_micros: '900000', unpriced_turns: '1', last_spend_at: '2001-03-03T12:00:00.000Z'
				}
			]);
		}
	});
});

describe('billing_metrics_people', () => {
	it('puts a sign-up in its SAST month and day, in any session time zone', async () => {
		for (const tz of ZONES) {
			const rows = await inZone<{ user_id: string; in_month: boolean; day: string; verified: boolean; first_run_at: Date | null }>(
				tz,
				`SELECT user_id, in_month, to_char(signup_day, 'YYYY-MM-DD') AS day, verified, first_run_at FROM billing_metrics_people($1::date) WHERE user_id = ANY($2) ORDER BY day`,
				[MONTH, [early.id, late.id]]
			);
			expect(rows, tz).toEqual([
				{ user_id: early.id, in_month: true, day: '2001-03-01', verified: true, first_run_at: new Date('2001-02-28T22:30:00Z') },
				{ user_id: late.id, in_month: false, day: '2001-04-01', verified: true, first_run_at: null }
			]);
		}
	});

	it('feeds the report: early activated in March; late is April’s', async () => {
		const r = await gatherReport(process.env.TEST_MIGRATION_DATABASE_URL!, '2001-03', new Date('2026-11-23T00:00:00Z'));
		expect(r.month).toBe('2001-03');
		expect(r.activation).toMatchObject({ cohort: 1, activated: 1, share: 1, pending: 0 });
		expect(r.heaviestFree).toContainEqual({ accountId: account, usdMicros: 900000 });
		const april = await gatherReport(process.env.TEST_MIGRATION_DATABASE_URL!, '2001-04', new Date('2026-11-23T00:00:00Z'));
		expect(april.activation).toMatchObject({ cohort: 1, activated: 0 });
	});

	it('feeds the report the month’s verified-email gate refusals (348), by SAST day', async () => {
		await asOwner(
			`INSERT INTO email_gate_refusal (day, code, feature, refusals) VALUES
			 ('2001-03-01', 'email_disposable', 'assistant', 2), ('2001-03-31', 'email_disposable', 'feeds', 1),
			 ('2001-03-31', 'email_unverified', 'assistant', 5), ('2001-04-01', 'email_disposable', 'assistant', 9)`
		);
		const r = await gatherReport(process.env.TEST_MIGRATION_DATABASE_URL!, '2001-03', new Date('2026-11-23T00:00:00Z'));
		expect(r.gateRefusals).toEqual({ disposable: { assistant: 2, feeds: 1, total: 3 }, unverified: { assistant: 5, feeds: 0, total: 5 } });
		const april = await gatherReport(process.env.TEST_MIGRATION_DATABASE_URL!, '2001-04', new Date('2026-11-23T00:00:00Z'));
		expect(april.gateRefusals.disposable).toEqual({ assistant: 9, feeds: 0, total: 9 });
	});
});

// 402: a run the app made by itself (model_run.trigger 'auto' or 'forecast', a live catchment's re-run) is not the
// person's activity. Before 402 an idle account with automatic runs on counted as active, and an automatic run
// within 7 days of signing up activated its person. June 2001, a month no other test writes to.
describe('automatic runs are not activity (402)', () => {
	const NOW = new Date('2026-11-23T00:00:00Z');
	let idle: User;
	let idleProject: string;
	let idleAccount: string;
	const run = (trigger: string, at: string) =>
		asOwner(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, created_at, trigger)
			 VALUES ($1, $2, '1.0.0', '2000-10-01', '2001-09-30', '{}', $3, $4)`,
			[idleProject, idle.id, at, trigger]
		);

	beforeAll(async () => {
		idle = await signUp('MetricsIdle');
		idleProject = (await idle.call('POST', '/projects', { name: 'Metrics idle synthetic' })).body.project.id;
		idleAccount = ((await asOwner('SELECT billing_account_id AS id FROM project WHERE id = $1', [idleProject])) as { id: string }[])[0]!.id;
		await asOwner(`UPDATE app_user SET created_at = '2001-06-02T08:00:00Z' WHERE id = $1`, [idle.id]);
		await run('auto', '2001-06-03T04:00:00Z');
		await run('forecast', '2001-06-04T04:00:00Z');
	});

	it('counts neither in the month’s runs nor as the first run, so the account is not active and its person not activated', async () => {
		const [acct] = (await asOwner('SELECT runs FROM billing_metrics_accounts($1::date) WHERE account_id = $2', ['2001-06-01', idleAccount])) as { runs: string }[];
		expect(acct!.runs).toBe('0');
		const [person] = (await asOwner('SELECT first_run_at FROM billing_metrics_people($1::date) WHERE user_id = $2', ['2001-06-01', idle.id])) as {
			first_run_at: Date | null;
		}[];
		expect(person!.first_run_at).toBeNull();
		const r = await gatherReport(process.env.TEST_MIGRATION_DATABASE_URL!, '2001-06', NOW);
		expect(r.freeLimits.active).toBe(0);
		expect(r.activation).toMatchObject({ cohort: 1, activated: 0 });
	});

	it('counts the person’s own run (positive control)', async () => {
		await run('manual', '2001-06-05T04:00:00Z');
		const [acct] = (await asOwner('SELECT runs FROM billing_metrics_accounts($1::date) WHERE account_id = $2', ['2001-06-01', idleAccount])) as { runs: string }[];
		expect(acct!.runs).toBe('1');
		const r = await gatherReport(process.env.TEST_MIGRATION_DATABASE_URL!, '2001-06', NOW);
		expect(r.freeLimits.active).toBe(1);
		expect(r.activation).toMatchObject({ cohort: 1, activated: 1 });
	});
});

describe('the reverse trial and the live catchments (342, 338)', () => {
	const NOW = new Date('2026-11-23T00:00:00Z');
	const report = (month: string) => gatherReport(process.env.TEST_MIGRATION_DATABASE_URL!, month, NOW);
	let lateAccount: string;

	beforeAll(async () => {
		lateAccount = ((await asOwner(
			`INSERT INTO billing_account (kind, user_id) VALUES ('user', $1) ON CONFLICT (user_id) DO UPDATE SET kind = EXCLUDED.kind RETURNING id`,
			[late.id]
		)) as { id: string }[])[0]!.id;
		const grant = (acct: string, at: string, by: string, plan = 'pro') =>
			asOwner(
				`INSERT INTO billing_grant_log (billing_account_id, action, plan_code, reason, granted_by, created_at) VALUES ($1, 'grant', $2, 'metrics test', $3, $4)`,
				[acct, plan, by, at]
			);
		// early: a trial at 00:30 SAST on 1 March (in March), paid by card 20 days later (a canceled mock subscription, so
		// the account stays Free today), and an earlier card plan from before the trial, which doesn't count.
		await grant(account, '2001-02-28T22:30:00Z', 'reverse trial');
		await asOwner(
			`INSERT INTO subscription (billing_account_id, plan_code, status, provider, external_ref, created_at) VALUES
			 ($1, 'pro', 'canceled', 'mock', 'metrics-early-before', '2001-01-10T00:00:00Z'),
			 ($1, 'pro', 'canceled', 'mock', 'metrics-early-paid', '2001-03-20T22:30:00Z')`,
			[account]
		);
		// late: a trial at 23:30 SAST on 31 March (in March), then only a staff grant (not paid) within the 30 days and a
		// paid invoice after them; and a second trial row at 00:30 SAST on 1 April (April's).
		await grant(lateAccount, '2001-03-31T21:30:00Z', 'reverse trial');
		await grant(lateAccount, '2001-04-05T00:00:00Z', 'operator');
		// …and a card checkout whose first payment never went through (Stripe's incomplete_expired, stored as expired):
		// not paid either.
		await asOwner(
			`INSERT INTO subscription (billing_account_id, plan_code, status, provider, external_ref, created_at) VALUES ($1, 'pro', 'expired', 'mock', 'metrics-late-unpaid', '2001-04-08T00:00:00Z')`,
			[lateAccount]
		);
		await grant(lateAccount, '2001-05-15T00:00:00Z', 'invoice');
		await grant(lateAccount, '2001-03-31T22:30:00Z', 'reverse trial');
	});

	afterAll(async () => {
		await asOwner(`DELETE FROM billing_grant_log WHERE reason = 'metrics test'`);
		await asOwner(`DELETE FROM subscription WHERE external_ref IN ('metrics-early-before', 'metrics-early-paid', 'metrics-late-unpaid')`);
		await asOwner(`UPDATE project SET settings = settings - 'autoRun' WHERE id = $1`, [projectId]);
	});

	it('counts the SAST month’s reverse trials and those paid within 30 days, by a card plan or an invoice, not a staff grant or an unpaid checkout', async () => {
		expect((await report('2001-03')).reverseTrial).toEqual({ cohort: 2, paid: 1, share: 0.5, pending: 0, pendingPaid: 0 });
		// April's trial: its invoice came 44 days on, so it isn't counted either.
		expect((await report('2001-04')).reverseTrial).toEqual({ cohort: 1, paid: 0, share: 0, pending: 0, pendingPaid: 0 });
		expect((await report('2001-02')).reverseTrial.cohort).toBe(0);
	});

	it('counts a trial whose 30 days are still open as pending', async () => {
		expect((await gatherReport(process.env.TEST_MIGRATION_DATABASE_URL!, '2001-03', new Date('2001-04-10T00:00:00Z'))).reverseTrial).toEqual({
			cohort: 1, paid: 1, share: 1, pending: 1, pendingPaid: 0
		});
	});

	it('counts an active Free account at its live-catchment limit once a catchment goes live (positive control)', async () => {
		const at = async () => (await report('2001-03')).freeLimits.limits.find((l) => l.limit === 'live_catchments')!;
		const before = await at();
		expect(before.value).toBe(1);
		await asOwner(`UPDATE project SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{autoRun}', '{"enabled": true}') WHERE id = $1`, [projectId]);
		const after = await at();
		expect(after.at).toBe(before.at + 1);
		// Counts only: the report names no account for it.
		expect(JSON.stringify(after)).not.toContain(account);
	});
});

describe('orphans past the provider\'s retries (352)', () => {
	const NOW = new Date('2026-11-24T12:00:00Z');
	const ids = ['evt_metrics_orphan_old', 'evt_metrics_orphan_new', 'evt_metrics_orphan_done'];

	beforeAll(async () => {
		await asOwner(
			`INSERT INTO billing_event (provider, event_id, type, outcome, received_at) VALUES
			 ('mock', $1, 'subscription.updated', 'orphan_pending', '2026-11-20T00:00:00Z'),
			 ('mock', $2, 'checkout.completed', 'orphan_pending', '2026-11-23T00:00:00Z'),
			 ('mock', $3, 'subscription.updated', 'orphan_refunded', '2026-11-01T00:00:00Z')`,
			ids
		);
	});

	afterAll(async () => {
		await asOwner(`DELETE FROM billing_event WHERE provider = 'mock' AND event_id = ANY($1)`, [ids]);
	});

	it('lists a pending orphan received more than 3 days ago, whatever the month; not a newer one or a refunded one', async () => {
		const mine = (r: Awaited<ReturnType<typeof gatherReport>>) => r.staleOrphans.filter((o) => ids.includes(o.eventId));
		const r = await gatherReport(process.env.TEST_MIGRATION_DATABASE_URL!, '2001-03', NOW);
		expect(mine(r)).toEqual([
			{ provider: 'mock', eventId: 'evt_metrics_orphan_old', type: 'subscription.updated', receivedAt: '2026-11-20T00:00:00.000Z', days: 4 }
		]);
		// Positive control: once its 3 days pass, the newer one is listed too.
		const later = await gatherReport(process.env.TEST_MIGRATION_DATABASE_URL!, '2001-03', new Date('2026-11-26T12:00:00Z'));
		expect(mine(later).map((o) => o.eventId)).toEqual(['evt_metrics_orphan_old', 'evt_metrics_orphan_new']);
	});
});

// 407: the first run is a record kept when runs go (the run cap trims them, a person deletes one, a project is deleted).
// Before 407 it was min(created_at) over the runs still stored, so a person whose runs were deleted stopped counting as
// activated. August 2001, a month no other test writes to.
describe('the first manual run is kept when runs are deleted (407)', () => {
	const NOW = new Date('2026-11-23T00:00:00Z');
	let keeper: User;
	let keeperProject: string;
	const run = (trigger: string, at: string) =>
		asOwner(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, created_at, trigger)
			 VALUES ($1, $2, '1.0.0', '2000-10-01', '2001-09-30', '{}', $3, $4) RETURNING id`,
			[keeperProject, keeper.id, at, trigger]
		);
	const recorded = async (id: string) =>
		((await asOwner('SELECT first_run_at FROM first_manual_run WHERE user_id = $1', [id])) as { first_run_at: Date }[])[0]?.first_run_at ?? null;

	beforeAll(async () => {
		keeper = await signUp('MetricsKeeper');
		keeperProject = (await keeper.call('POST', '/projects', { name: 'Metrics keeper synthetic' })).body.project.id;
		await asOwner(`UPDATE app_user SET created_at = '2001-08-02T08:00:00Z' WHERE id = $1`, [keeper.id]);
	});

	it('records the first manual run when it is saved, not an automatic one, and a later run never moves it', async () => {
		await run('auto', '2001-08-02T09:00:00Z');
		expect(await recorded(keeper.id)).toBeNull();
		await run('manual', '2001-08-03T04:00:00Z');
		expect(await recorded(keeper.id)).toEqual(new Date('2001-08-03T04:00:00Z'));
		await run('manual', '2001-08-04T04:00:00Z');
		expect(await recorded(keeper.id)).toEqual(new Date('2001-08-03T04:00:00Z'));
	});

	it('still activates the person after every run of theirs is deleted', async () => {
		await asOwner('DELETE FROM model_run WHERE project_id = $1', [keeperProject]);
		expect((await asOwner('SELECT count(*)::int AS n FROM model_run WHERE created_by = $1', [keeper.id]))[0]!.n).toBe(0);
		const [person] = (await asOwner('SELECT first_run_at FROM billing_metrics_people($1::date) WHERE user_id = $2', ['2001-08-01', keeper.id])) as {
			first_run_at: Date | null;
		}[];
		expect(person!.first_run_at).toEqual(new Date('2001-08-03T04:00:00Z'));
		const r = await gatherReport(process.env.TEST_MIGRATION_DATABASE_URL!, '2001-08', NOW);
		expect(r.activation).toMatchObject({ cohort: 1, activated: 1 });
	});

	it('is owner only: the app role reads and writes nothing of it, signed in or not', async () => {
		const app = new pg.Client({ connectionString: APP_URL });
		await app.connect();
		try {
			for (const sql of ['SELECT * FROM first_manual_run', `INSERT INTO first_manual_run (user_id, first_run_at) VALUES ('${keeper.id}', now())`, 'DELETE FROM first_manual_run']) {
				const code = await app.query(sql).then(
					() => 'ok',
					(e: { code?: string }) => e.code
				);
				expect(code, sql).toBe('42501');
			}
		} finally {
			await app.end();
		}
		// Positive control: the row is there for the owner.
		expect(await recorded(keeper.id)).not.toBeNull();
	});
});

describe('owner only', () => {
	it('water_app can neither execute nor call them; the owner can (positive control)', async () => {
		const grants = (await asOwner(
			`SELECT has_function_privilege('water_app', 'billing_metrics_accounts(date)', 'EXECUTE') AS a,
			        has_function_privilege('water_app', 'billing_metrics_people(date)', 'EXECUTE') AS p,
			        has_function_privilege('public', 'billing_metrics_people(date)', 'EXECUTE') AS pub`
		)) as { a: boolean; p: boolean; pub: boolean }[];
		expect(grants[0]).toEqual({ a: false, p: false, pub: false });
		const app = new pg.Client({ connectionString: APP_URL });
		await app.connect();
		try {
			for (const fn of ['billing_metrics_accounts', 'billing_metrics_people']) {
				const code = await app.query(`SELECT count(*) FROM ${fn}($1::date)`, [MONTH]).then(
					() => 'ok',
					(e: { code?: string }) => e.code
				);
				expect(code, fn).toBe('42501');
			}
		} finally {
			await app.end();
		}
		expect(((await asOwner('SELECT count(*)::int AS n FROM billing_metrics_people($1::date) WHERE user_id = $2', [MONTH, early.id])) as { n: number }[])[0]!.n).toBe(1);
	});
});
