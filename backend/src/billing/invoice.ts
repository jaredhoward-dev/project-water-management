// A B2B invoice from the staff tool (issue #641 Phase 5, "a Stripe Invoice
// from the staff tool, net 30, and a PO number on the invoice";
// docs/billing.md § B2B invoices). The operator invoices a person's or a
// team's billing account for its plan (Pro for a person, Team for a team) at
// the plan table's price × seats × interval, with the customer's PO number
// printed on the invoice. The provider makes the invoice and emails it
// (provider.ts createInvoice: Stripe's, or the mock's with no network).
//
// Two callers, as for the staff grant: the local script
// (scripts/billing-invoice.ts) and the migrate Lambda's `billing-invoice`
// owner action (ops/ownerActions.ts, direct invoke only: a PO number may
// identify a client, so it never goes into a public workflow's inputs).
//
// This writes nothing but the account (billing_account_ensure) and its
// customer (328's column, first writer wins): the invoice lives at the
// provider, which is its record. Its metadata carries the grant (plan, seats,
// interval, period; provider/stripeApi.ts invoiceMetadata), so when it is
// paid, its invoice.paid grants the plan for the invoiced period through the
// webhook (app_billing_apply, 335), with no step for the operator.
//
// No dotenv here or below: the migrate Lambda bundles this module.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { listPlans } from './entitlements.js';
import { checkoutPlanOf, checkoutPrices, PURCHASABLE, type BillingInterval, type BillingProvider, type CheckoutPlan, type InvoiceRequest as ProviderInvoiceRequest, type InvoiceResult } from './provider.js';
import { isCalendarDate, ownedAccount, type Owner, type Target } from './staffGrant.js';
import type { Db } from '../db/tx.js';

/** The most editor seats one invoice sells (as checkout's MAX_CHECKOUT_SEATS; past it is a contract). */
export const MAX_INVOICE_SEATS = 50;
/**
 * A PO number: 1–64 characters of letters, digits, space and . / _ # : ( ) -,
 * starting with a letter or digit. Stripe takes up to 140 in a custom field;
 * 64 is ample for a purchase order and keeps the field one line on the PDF.
 */
export const PO_NUMBER = /^[A-Za-z0-9][A-Za-z0-9 ./_#:()-]{0,63}$/;

/** A refusal before anything reaches the provider; `code` is what a public answer says. */
export class InvoiceError extends Error {
	constructor(
		message: string,
		readonly code: 'invalid' | 'live_subscription'
	) {
		super(message);
		this.name = 'InvoiceError';
	}
}

export interface InvoiceRequest {
	target: Target;
	plan: string;
	interval: BillingInterval;
	/** Editor seats in all; default the plan's included seats. */
	seats?: number;
	/** The period's first day (YYYY-MM-DD, SAST); default today in SAST. */
	from?: string | null;
	poNumber: string;
}

export interface Invoiced extends Owner {
	accountId: string;
	plan: string;
	seats: number;
	interval: BillingInterval;
	/** The period paid for, as SAST calendar days (through `until`: paying the invoice grants the plan until this day ends). */
	from: string;
	until: string;
	invoice: InvoiceResult;
	/** What the provider was asked for (the mock's paid event is built from it, provider/mock.ts invoicePaidEvent). */
	request: ProviderInvoiceRequest;
}

const SAST_OFFSET_MS = 2 * 3_600_000;
/** Today's date in South Africa, whatever this machine's zone. */
export function sastToday(nowMs = Date.now()): string {
	return new Date(nowMs + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The period from `from` (a SAST day) for one interval: its last day, and both ends as unix seconds (SAST midnights). */
export function invoicePeriod(from: string, interval: BillingInterval): { until: string; start: number; end: number } {
	const [y, m, d] = from.split('-').map(Number) as [number, number, number];
	// The same day next month or year; a day the month doesn't have (31 Jan + 1 month) clamps to its last day.
	const months = interval === 'year' ? 12 : 1;
	const targetMonth = new Date(Date.UTC(y, m - 1 + months, 1));
	const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
	const next = Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth(), Math.min(d, lastDay));
	const start = Date.UTC(y, m - 1, d) - SAST_OFFSET_MS;
	const end = next - SAST_OFFSET_MS;
	const until = new Date(next - 86_400_000).toISOString().slice(0, 10);
	return { until, start: start / 1000, end: end / 1000 };
}

/** The invoice's lines: the plan (its included seats), and the extra seats past them when any (Team). */
export function invoiceLines(plan: CheckoutPlan, interval: BillingInterval, seats: number, from: string, until: string): { amountMinor: number; description: string }[] {
	const p = checkoutPrices(plan, interval, seats);
	const period = `${interval === 'year' ? '1 year' : '1 month'}, ${from} to ${until}`;
	const included = plan.seatsIncluded === 1 ? '1 editor seat' : `${plan.seatsIncluded} editor seats`;
	const lines = [{ amountMinor: p.baseMinor, description: `IC-WBT ${plan.name} (${included}), ${period}` }];
	if (p.extraSeats > 0) {
		lines.push({ amountMinor: p.extraSeats * p.extraSeatMinor, description: `IC-WBT ${plan.name}: ${p.extraSeats} extra editor seat${p.extraSeats === 1 ? '' : 's'}, ${period}` });
	}
	return lines;
}

/** Our key for one invoice: the account, plan, seats, interval, period and PO number. The same request is the same key. */
export function invoiceKey(accountId: string, plan: string, interval: BillingInterval, seats: number, from: string, poNumber: string): string {
	const h = createHash('sha256').update(JSON.stringify([accountId, plan, interval, seats, from, poNumber])).digest('hex').slice(0, 32);
	return `${accountId}-${h}`;
}

/** Check a request before any lookup: the plan is the kind's, the seats in range, the date real, the PO number well formed. */
export function checkInvoiceRequest(req: InvoiceRequest): void {
	if (!PO_NUMBER.test(req.poNumber)) throw new InvoiceError('the PO number is 1–64 letters, digits, spaces and . / _ # : ( ) -, starting with a letter or digit', 'invalid');
	if (req.from != null && !isCalendarDate(req.from)) throw new InvoiceError('from is a date, YYYY-MM-DD', 'invalid');
	if (req.seats !== undefined && (!Number.isInteger(req.seats) || req.seats < 1 || req.seats > MAX_INVOICE_SEATS)) throw new InvoiceError(`seats is a whole number from 1 to ${MAX_INVOICE_SEATS}`, 'invalid');
}

/**
 * Issue the invoice on the schema owner's connection: find (or make) the
 * account, price the plan from the plan table, make the provider's customer
 * if the account has none (stored as checkout stores it), then the provider
 * makes and sends the invoice. A live Stripe subscription is refused: the
 * customer already pays by card, and an invoice on top would bill them twice.
 */
export async function issueInvoice(client: pg.ClientBase, provider: BillingProvider, req: InvoiceRequest, nowMs = Date.now()): Promise<Invoiced> {
	checkInvoiceRequest(req);
	const owner = await ownedAccount(client, req.target, true);
	const accountId = owner.accountId!;
	if (req.plan !== PURCHASABLE[owner.kind]) throw new InvoiceError(`a ${owner.kind === 'team' ? 'team' : 'person'} is invoiced for ${PURCHASABLE[owner.kind]}, not ${req.plan}`, 'invalid');
	const plans = await listPlans(client as unknown as Db);
	const found = plans.find((p) => p.code === req.plan);
	if (!found) throw new InvoiceError(`no active plan ${req.plan}`, 'invalid');
	const plan = checkoutPlanOf(found);
	const seats = req.seats ?? plan.seatsIncluded;
	const extraPrice = req.interval === 'year' ? plan.extraSeatAnnualMinor : plan.extraSeatMonthlyMinor;
	if (seats < plan.seatsIncluded) throw new InvoiceError(`the ${plan.name} plan includes ${plan.seatsIncluded} seats; invoice at least that many`, 'invalid');
	if (seats > plan.seatsIncluded && extraPrice === null) throw new InvoiceError(`the ${plan.name} plan sells no extra seats`, 'invalid');

	const { rows: live } = await client.query<{ provider: string }>(
		`SELECT provider FROM subscription WHERE billing_account_id = $1 AND status IN ('trialing', 'active', 'past_due', 'lapsed') AND provider = 'stripe'`,
		[accountId]
	);
	if (live[0]) throw new InvoiceError('the account has a live Stripe subscription; it already pays by card', 'live_subscription');

	const from = req.from ?? sastToday(nowMs);
	const period = invoicePeriod(from, req.interval);
	const { rows } = await client.query<{ ref: string | null }>('SELECT external_customer_ref AS ref FROM billing_account WHERE id = $1', [accountId]);
	const request: ProviderInvoiceRequest = {
		account: { id: accountId, customerRef: rows[0]?.ref ?? null },
		planCode: plan.code,
		seats,
		interval: req.interval,
		currency: plan.currency,
		poNumber: req.poNumber,
		periodStart: period.start,
		periodEnd: period.end,
		lines: invoiceLines(plan, req.interval, seats, from, period.until),
		key: invoiceKey(accountId, plan.code, req.interval, seats, from, req.poNumber)
	};
	const invoice = await provider.createInvoice(request);
	if (invoice.newCustomerRef) {
		// First writer wins (328): a checkout that made a customer meanwhile keeps its own.
		await client.query('UPDATE billing_account SET external_customer_ref = $2 WHERE id = $1 AND external_customer_ref IS NULL', [accountId, invoice.newCustomerRef]);
	}
	return { kind: owner.kind, ownerId: owner.ownerId, accountId, plan: plan.code, seats, interval: req.interval, from, until: period.until, invoice, request };
}
