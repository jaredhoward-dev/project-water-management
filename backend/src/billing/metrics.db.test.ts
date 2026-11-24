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
