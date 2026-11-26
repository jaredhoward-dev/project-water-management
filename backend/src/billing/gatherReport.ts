// The billing metrics report's rows (325_billing_metrics's owner-only
// functions, 338's live count, 342's reverse trials in billing_grant_log, 352's orphans still pending) on a schema-owner connection, built into the report by
// metrics.ts (issue #641; docs/billing.md § Metrics and the abuse report).
// Two callers: the local script (scripts/billing-report.ts) and the migrate
// Lambda's billing-report action (ops/ownerActions.ts), which answers with
// redact(report) only. No dotenv here: the migrate Lambda bundles this module.
import type pg from 'pg';
import { buildReport, type AccountRow, type GateRefusalRow, type OpenConflict, type OrphanPendingRow, type PersonRow, type PlanLimits, type Report, type ReverseTrialRow } from './metrics.js';

/** The month's report (YYYY-MM, or null for the current SAST month), addresses included: redact before it leaves the caller. */
export async function gatherReportOn(client: pg.ClientBase, month: string | null, now = new Date()): Promise<Report> {
	const first = month
		? `${month}-01`
		: ((await client.query<{ m: string }>(`SELECT to_char(app_billing_month($1), 'YYYY-MM-DD') AS m`, [now])).rows[0]!.m);
	// Each account's live catchments today (338's count; owner-only, like the rest of the report).
	const live = new Map(
		(await client.query<{ id: string; live: string }>('SELECT id, app_live_catchments_in_use(id) AS live FROM billing_account')).rows.map((r) => [r.id, Number(r.live)])
	);
	const accounts = (
		await client.query<{
			account_id: string; kind: 'user' | 'team'; plan_code: string; started_at: Date; catchments: string; runs: string; reports: string;
			assistant_usd_micros: string; unpriced_turns: string; last_spend_at: Date | null;
		}>('SELECT * FROM billing_metrics_accounts($1::date)', [first])
	).rows.map(
		(r): AccountRow => ({
			accountId: r.account_id, kind: r.kind, planCode: r.plan_code, startedAt: r.started_at, catchments: Number(r.catchments), runs: Number(r.runs),
			reports: Number(r.reports), assistantUsdMicros: Number(r.assistant_usd_micros), unpricedTurns: Number(r.unpriced_turns), lastSpendAt: r.last_spend_at,
			liveCatchments: live.get(r.account_id) ?? 0
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
	// The reverse trials (342) that began in the SAST month, from billing_grant_log, and each account's first paid plan
	// from the trial's start on: a payment provider's subscription whose first payment was taken (Stripe, or the local mock:
	// active, past_due or canceled; not trialing, and not expired, which is Stripe's incomplete_expired, a first payment
	// never made), or a paid invoice's grant (335). Staff grants are not paid. Dates only: no account id leaves this query.
	const trials = (
		await client.query<{ started_at: Date; first_paid_at: Date | null }>(
			`SELECT g.created_at AS started_at,
			        least(
			          (SELECT min(s.created_at) FROM subscription s
			           WHERE s.billing_account_id = g.billing_account_id AND s.provider IN ('stripe', 'mock') AND s.status IN ('active', 'past_due', 'lapsed', 'canceled')
			             AND s.created_at >= g.created_at),
			          (SELECT min(l.created_at) FROM billing_grant_log l
			           WHERE l.billing_account_id = g.billing_account_id AND l.action = 'grant' AND l.granted_by = 'invoice'
			             AND l.created_at >= g.created_at)
			        ) AS first_paid_at
			 FROM billing_grant_log g
			 WHERE g.action = 'grant' AND g.granted_by = 'reverse trial'
			   AND g.created_at >= $1::date::timestamp AT TIME ZONE 'Africa/Johannesburg'
			   AND g.created_at < ($1::date + interval '1 month')::timestamp AT TIME ZONE 'Africa/Johannesburg'`,
			[first]
		)
	).rows.map((r): ReverseTrialRow => ({ startedAt: r.started_at, firstPaidAt: r.first_paid_at }));
	// Orphans (352) still pending, whatever the month: buildReport keeps those past the provider's retries. billing_event
	// is owner-only, like the rest; the rows carry the provider's event id and type, never an account or a person.
	const orphans = (
		await client.query<{ provider: string; event_id: string; type: string; received_at: Date }>(
			`SELECT provider, event_id, type, received_at FROM billing_event WHERE outcome = 'orphan_pending' ORDER BY received_at`
		)
	).rows.map((r): OrphanPendingRow => ({ provider: r.provider, eventId: r.event_id, type: r.type, receivedAt: r.received_at }));
	// Open price conflicts (406), whatever the month: billing_conflict is owner-only and holds ids and amounts, no person.
	const conflicts = (
		await client.query<{
			provider: string; billing_account_id: string; external_ref: string; event_id: string; reason: string; plan_code: string;
			billing_interval: string | null; seats: number; amount_minor: string | null; currency: string | null; expected_minor: string | null;
			held: boolean; created_at: Date;
		}>(
			`SELECT provider, billing_account_id, external_ref, event_id, reason, plan_code, billing_interval, seats, amount_minor, currency,
			        expected_minor, held, created_at
			 FROM billing_conflict WHERE resolved_at IS NULL ORDER BY created_at, id`
		)
	).rows.map(
		(r): OpenConflict => ({
			provider: r.provider,
			accountId: r.billing_account_id,
			externalRef: r.external_ref,
			eventId: r.event_id,
			reason: r.reason,
			planCode: r.plan_code,
			interval: r.billing_interval,
			seats: r.seats,
			amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
			currency: r.currency,
			expectedMinor: r.expected_minor === null ? null : Number(r.expected_minor),
			held: r.held,
			createdAt: r.created_at.toISOString()
		})
	);
	return buildReport(first.slice(0, 7), now, accounts, people, limits, refusals, trials, orphans, conflicts);
}
