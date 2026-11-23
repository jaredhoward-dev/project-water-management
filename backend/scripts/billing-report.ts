// The Phase 1 billing metrics and the staff abuse report (issue #641), locally:
//
//   pnpm dev:billing:report [--month YYYY-MM] [--json] [--show-emails]
//
// There is no staff role in the app, so this is the operator's report, run as
// the schema owner (MIGRATION_DATABASE_URL) on this checkout's dev database,
// like dev:authority:confirm; in production the operator runs it against the
// database as the schema owner. It reads 325_billing_metrics's owner-only
// functions; the maths is src/billing/metrics.ts. The month defaults to the
// current one in Africa/Johannesburg.
//
// The output holds counts and aggregates, plus account and person ids where a
// signal needs a follow-up. It never prints an address unless --show-emails
// is given: operator only, never pasted into an issue, a PR or a transcript
// (docs/billing.md § Metrics and the abuse report).
import pg from 'pg';
import { loadDevEnv } from '../src/config/devEnv.js';
import { buildReport, formatReport, redact, type AccountRow, type PersonRow, type PlanLimits, type Report } from '../src/billing/metrics.js';

export interface ReportArgs {
	/** YYYY-MM, or null for the current SAST month. */
	month: string | null;
	json: boolean;
	showEmails: boolean;
}

export const USAGE = 'usage: pnpm dev:billing:report [--month YYYY-MM] [--json] [--show-emails]';

/** The arguments, or why they can't be taken. */
export function parseArgs(argv: string[]): ReportArgs | string {
	const args: ReportArgs = { month: null, json: false, showEmails: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === '--json') args.json = true;
		else if (a === '--show-emails') args.showEmails = true;
		else if (a === '--month') {
			const m = argv[++i] ?? '';
			if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return 'give --month as YYYY-MM';
			args.month = m;
		} else return `unexpected argument ${a}`;
	}
	return args;
}

/** Gather the month's rows as the schema owner at `url` and build the report (addresses included; redact before printing). */
export async function gatherReport(url: string, month: string | null, now = new Date()): Promise<Report> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
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
		return buildReport(first.slice(0, 7), now, accounts, people, limits);
	} finally {
		await client.end();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseArgs(process.argv.slice(2));
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	if (typeof args === 'string') {
		console.error(`${args}\n${USAGE}`);
		process.exit(2);
	}
	gatherReport(url, args.month)
		.then((report) => {
			const shown = args.showEmails ? report : redact(report);
			console.log(args.json ? JSON.stringify(shown, null, 2) : formatReport(shown, args.showEmails));
			process.exit(0);
		})
		.catch((err: Error) => {
			console.error(err.message);
			process.exit(1);
		});
}
