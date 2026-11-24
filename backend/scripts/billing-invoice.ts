// The operator's B2B invoice (issue #641 Phase 5; docs/billing.md § B2B
// invoices), locally:
//
//   pnpm dev:billing:invoice <email|team-id> <plan> --interval month|year --po "<PO number>" [--seats n] [--from YYYY-MM-DD] [--paid]
//
// Paying the invoice grants the plan through the webhook (app_billing_apply,
// 335). With the mock, --paid stands in for the customer paying: it posts the
// mock's signed invoice.paid to the real webhook route, as the mock checkout does.
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
export const USAGE = 'usage: pnpm dev:billing:invoice <email|team-id> <plan> --interval month|year --po "<PO number>" [--seats n] [--from YYYY-MM-DD] [--paid]';

/** The request, and --paid: the mock pays it at once (local only). */
export type ScriptRequest = InvoiceRequest & { paid?: boolean };

/** The arguments as a request, or why they can't be taken. The request's own checks (PO number, seats, date) run in issueInvoice. */
export function parseArgs(argv: string[]): ScriptRequest | string {
	const flags = new Map<string, string>();
	const positional: string[] = [];
	let paid = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === '--paid') paid = true;
		else if (VALUE_FLAGS.has(a)) {
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
	const req: ScriptRequest = { target, plan: plan.toLowerCase(), interval, poNumber: po, seats: seatsText === undefined ? undefined : Number(seatsText), from: flags.get('--from') ?? null };
	if (paid) req.paid = true;
	return req;
}

/** Issue the invoice on the schema owner's connection `url`; returns the lines to print. */
export async function runInvoice(url: string, req: ScriptRequest, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
	const provider = billingProvider(env);
	if (!provider) throw new Error('BILLING_PROVIDER names no provider');
	if (req.paid && provider.name !== 'mock') throw new Error('--paid is the mock’s: a real invoice is paid by the customer');
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const r = await issueInvoice(client, provider, req);
		const i = r.invoice;
		const lines = [
			`${i.reused ? 'Already invoiced' : 'Invoiced'} ${describeTarget(req.target)} (${provider.name}): ${i.invoiceId}${i.number ? ` (${i.number})` : ''}, ${r.plan} × ${r.seats} seats, ${r.from} to ${r.until}, ${(i.totalMinor / 100).toFixed(2)}, ${i.status}${i.dueAt ? `, due ${i.dueAt.slice(0, 10)}` : ''}.`
		];
		if (!req.paid) {
			lines.push(`Once it is paid, its invoice.paid grants ${r.plan} until ${r.until} through the webhook (docs/billing.md § B2B invoices).`);
			return lines;
		}
		// The customer pays (the mock's stand-in): the signed invoice.paid through the real webhook route.
		const { deliverMockEvent } = await import('../src/billing/mockCheckout.js');
		const { invoicePaidEvent } = await import('../src/billing/provider/mock.js');
		if (!(await deliverMockEvent(invoicePaidEvent(r.request, i.invoiceId)))) throw new Error('the webhook refused the mock invoice.paid; the backend log says why');
		// A 200 may still be a conflict (logged): say what the database holds.
		const { rows } = await client.query('SELECT 1 FROM subscription WHERE provider = $1 AND external_ref = $2', ['manual', i.invoiceId]);
		lines.push(rows[0] ? `Paid (mock): ${r.plan} granted until ${r.until} through the webhook.` : 'Paid (mock), but nothing was granted: the backend log says why (billing_webhook, result conflict).');
		return lines;
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
