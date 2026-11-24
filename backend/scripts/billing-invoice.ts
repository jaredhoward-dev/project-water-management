// The operator's B2B invoice (issue #641 Phase 5; docs/billing.md § B2B
// invoices), locally:
//
//   pnpm dev:billing:invoice <email|team-id> <plan> --interval month|year --po "<PO number>" [--seats n] [--from YYYY-MM-DD]
//
// Runs src/billing/invoice.ts issueInvoice as the schema owner
// (MIGRATION_DATABASE_URL) on this checkout's dev database, through the
// configured BILLING_PROVIDER: the mock by default (no network, a made-up
// in_mock_… invoice), or Stripe in test mode with a test key in
// backend/.env.development.local. `manual` refuses (its invoices are sent
// from Stripe's dashboard). In production the operator runs the same
// function through the migrate Lambda's billing-invoice owner action, from
// their SSO session only (docs/deployment.md § Owner actions).
import pg from 'pg';
import { issueInvoice, type InvoiceRequest } from '../src/billing/invoice.js';
import { billingProvider } from '../src/billing/provider.js';
import { describeTarget, type Target } from '../src/billing/staffGrant.js';
import { loadDevEnv } from '../src/config/devEnv.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALUE_FLAGS = new Set(['--interval', '--po', '--seats', '--from']);
export const USAGE = 'usage: pnpm dev:billing:invoice <email|team-id> <plan> --interval month|year --po "<PO number>" [--seats n] [--from YYYY-MM-DD]';

/** The arguments as a request, or why they can't be taken. The request's own checks (PO number, seats, date) run in issueInvoice. */
export function parseArgs(argv: string[]): InvoiceRequest | string {
	const flags = new Map<string, string>();
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (VALUE_FLAGS.has(a)) {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith('--')) return `${a} needs a value`;
			flags.set(a, v);
			i++;
		} else if (a.startsWith('--')) return `unknown option ${a}`;
		else positional.push(a);
	}
	const [who, plan, extra] = positional;
	if (!who) return 'give the person’s email address or the team’s id';
	let target: Target;
	if (UUID.test(who)) target = { kind: 'team', teamId: who.toLowerCase() };
	else if (who.includes('@')) target = { kind: 'user', email: who.trim().toLowerCase() };
	else return 'give the person’s email address or the team’s id (a uuid)';
	if (!plan) return 'give the plan to invoice (pro for a person, team for a team)';
	if (extra) return `unexpected argument ${extra}`;
	const interval = flags.get('--interval');
	if (interval !== 'month' && interval !== 'year') return 'give --interval month or --interval year';
	const po = flags.get('--po')?.trim();
	if (!po) return 'give the customer’s PO number with --po (it is printed on the invoice)';
	const seatsText = flags.get('--seats');
	if (seatsText !== undefined && !/^\d+$/.test(seatsText)) return '--seats is a whole number';
	return { target, plan: plan.toLowerCase(), interval, poNumber: po, seats: seatsText === undefined ? undefined : Number(seatsText), from: flags.get('--from') ?? null };
}

/** Issue the invoice on the schema owner's connection `url`; returns the lines to print. */
export async function runInvoice(url: string, req: InvoiceRequest, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
	const provider = billingProvider(env);
	if (!provider) throw new Error('BILLING_PROVIDER names no provider');
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const r = await issueInvoice(client, provider, req);
		const i = r.invoice;
		return [
			`${i.reused ? 'Already invoiced' : 'Invoiced'} ${describeTarget(req.target)} (${provider.name}): ${i.invoiceId}${i.number ? ` (${i.number})` : ''}, ${r.plan} × ${r.seats} seats, ${r.from} to ${r.until}, ${(i.totalMinor / 100).toFixed(2)}, ${i.status}${i.dueAt ? `, due ${i.dueAt.slice(0, 10)}` : ''}.`,
			`Once it is paid: pnpm dev:billing:grant ${req.target.kind === 'team' ? (req.target as { teamId: string }).teamId : describeTarget(req.target)} ${r.plan} --until ${r.until} --reason "Invoice ${i.number ?? i.invoiceId}, PO ${req.poNumber}"`
		];
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
	runInvoice(url, args)
		.then((lines) => {
			for (const l of lines) console.log(l);
			process.exit(0);
		})
		.catch((err: Error) => {
			console.error(err.message);
			process.exit(1);
		});
}
