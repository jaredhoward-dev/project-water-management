// The billing metrics report's rows (325_billing_metrics's owner-only
// functions) on a schema-owner connection, built into the report by
// metrics.ts (issue #641; docs/billing.md § Metrics and the abuse report).
// Two callers: the local script (scripts/billing-report.ts) and the migrate
// Lambda's billing-report action (ops/ownerActions.ts), which answers with
// redact(report) only. No dotenv here: the migrate Lambda bundles this module.
import type pg from 'pg';
import { buildReport, type AccountRow, type GateRefusalRow, type PersonRow, type PlanLimits, type Report } from './metrics.js';

/** The month's report (YYYY-MM, or null for the current SAST month), addresses included: redact before it leaves the caller. */
export async function gatherReportOn(client: pg.ClientBase, month: string | null, now = new Date()): Promise<Report> {
	const first = month
		? `${month}-01`
		: ((await client.query<{ m: string }>(`SELECT to_char(app_billing_month($1), 'YYYY-MM-DD') AS m`, [now])).rows[0]!.m);
	const accounts = (
		await client.query<{
			account_id: string; kind: 'user' | 'team'; plan_code: string; started_at: Date; catchments: string; runs: string; reports: string;
			assistant_usd_micros: string; unpriced_turns: string; last_spend_at: Date | null;
		}>('SELECT * FROM billing_metrics_accounts($1::date)', [first])
	).rows.map(
		(r): AccountRow => ({
			accountId: r.account_id, kind: r.kind, planCode: r.plan_code, startedAt: r.started_at, catchments: Number(r.catchments), runs: Number(r.runs),
			reports: Number(r.reports), assistantUsdMicros: Number(r.assistant_usd_micros), unpricedTurns: Number(r.unpriced_turns), lastSpendAt: r.last_spend_at
		})
	);
	const people = (
		await client.query<{ user_id: string; email: string; created_at: Date; verified: boolean; first_run_at: Date | null; in_month: boolean; signup_day: string }>(
			`SELECT user_id, email, created_at, verified, first_run_at, in_month, to_char(signup_day, 'YYYY-MM-DD') AS signup_day FROM billing_metrics_people($1::date)`,
			[first]
		)
	).rows.map(
		(r): PersonRow => ({ userId: r.user_id, email: r.email, createdAt: r.created_at, verified: r.verified, firstRunAt: r.first_run_at, inMonth: r.in_month, signupDay: r.signup_day })
	);
	const limits = (await client.query<{ limits: PlanLimits }>(`SELECT limits FROM plan WHERE code = 'free'`)).rows[0]?.limits ?? {};
	// The verified-email gate's refusals (348), by SAST day: the month's days.
	const refusals = (
		await client.query<{ code: GateRefusalRow['code']; feature: GateRefusalRow['feature']; refusals: string }>(
			`SELECT code, feature, sum(refusals) AS refusals FROM email_gate_refusal
			 WHERE day >= $1::date AND day < ($1::date + interval '1 month')::date GROUP BY code, feature`,
			[first]
		)
	).rows.map((r): GateRefusalRow => ({ code: r.code, feature: r.feature, refusals: Number(r.refusals) }));
	return buildReport(first.slice(0, 7), now, accounts, people, limits, refusals);
}
