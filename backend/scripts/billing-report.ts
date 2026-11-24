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
import { gatherReportOn } from '../src/billing/gatherReport.js';
import { formatReport, redact, type Report } from '../src/billing/metrics.js';

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
		return await gatherReportOn(client, month, now);
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
