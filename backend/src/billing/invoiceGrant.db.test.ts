// A paid B2B invoice grants its plan (335_invoice_grant.sql, issue #641: invoicing a WUA against a PO;
// docs/billing.md § B2B invoices). app_billing_apply, called as the webhook calls it (no user, water_app):
//  - invoice.paid carrying `invoice` (the normaliser's, for a staff-tool invoice) writes a manual, active,
//    cancel-at-period-end subscription for the invoiced plan, seats, interval and period, keyed by the invoice
//    id, and logs the grant; a replay is a duplicate, the same invoice under another event id is recorded only;
//  - invoice.payment_failed never touches it, before or after;
//  - what doesn't check out (a field missing or malformed, the wrong plan for the kind, another currency, a total
//    below the plan table's price, a period past or longer than one interval) is a recorded conflict, never
//    raised, with a positive control that the corrected invoice grants;
//  - a live card subscription or an open-ended grant is never ended; the previous period's grant is replaced;
//  - an invoice.paid on a subscription's invoice still grants nothing.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Plan = { price_monthly_minor: number; price_annual_minor: number; currency: string; included: number; extra_annual: number | null };
const accounts: string[] = [];
let pro: Plan;
let team: Plan;

const apply = (type: string, payload: unknown, eventId = `evt_${randomUUID().replace(/-/g, '')}`, provider = 'stripe') =>
	withoutUser(
		async (db) =>
			(await db.query<{ r: string }>('SELECT app_billing_apply($1, $2, $3, $4::jsonb) AS r', [provider, eventId, type, JSON.stringify(payload)])).rows[0]!.r
	);
const outcome = async (eventId: string, provider = 'stripe') =>
	((await asOwner('SELECT outcome FROM billing_event WHERE provider = $1 AND event_id = $2', [provider, eventId])) as { outcome: string }[])[0]?.outcome;
const subs = async (acct: string) =>
	(await asOwner(
		`SELECT provider, external_ref, plan_code, status, seats, billing_interval, cancel_at_period_end, period_start, period_end
		 FROM subscription WHERE billing_account_id = $1 ORDER BY created_at, external_ref`,
		[acct]
	)) as { provider: string; external_ref: string | null; plan_code: string; status: string; seats: number; billing_interval: string | null; cancel_at_period_end: boolean; period_start: Date; period_end: Date | null }[];
const log = async (acct: string) =>
	(await asOwner('SELECT action, plan_code, granted_by, reason FROM billing_grant_log WHERE billing_account_id = $1 ORDER BY created_at', [acct])) as {
		action: string;
		plan_code: string;
		granted_by: string;
		reason: string;
	}[];

async function personAccount(name: string): Promise<{ user: User; account: string }> {
	const user = await signUp(name);
	const account = await withUser(user.id, async (db) => (await db.query<{ id: string }>('SELECT app_my_billing_account() AS id')).rows[0]!.id);
	accounts.push(account);
	return { user, account };
}
async function teamAccount(name: string): Promise<string> {
	const admin = await signUp(name);
	const teamId = (await admin.call('POST', '/teams', { name: `${name} WUA` })).body.team.id as string;
	const [row] = (await asOwner(`SELECT billing_account_ensure('team', $1) AS id`, [teamId])) as { id: string }[];
	accounts.push(row!.id);
	return row!.id;
}

const DAY = 86_400_000;
/** One interval from `startMs`, as invoicePeriod makes it (the same day next month or year). */
function period(startMs: number, interval: 'month' | 'year'): { periodStart: string; periodEnd: string } {
	const s = new Date(startMs);
	const months = interval === 'year' ? 12 : 1;
	// A day the target month doesn't have (31 Jan + 1 month) clamps to its last day, as invoicePeriod does.
	const lastDay = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + months + 1, 0)).getUTCDate();
	const end = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + months, Math.min(s.getUTCDate(), lastDay), s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds(), s.getUTCMilliseconds()));
	return { periodStart: new Date(startMs).toISOString(), periodEnd: end.toISOString() };
}
/** The payload the normaliser builds for a paid staff-tool invoice, priced from the plan table. */
function paid(account: string, over: Record<string, unknown> = {}, opts: { plan?: Plan; planCode?: string; seats?: number; interval?: 'month' | 'year'; startMs?: number } = {}) {
	const plan = opts.plan ?? pro;
	const seats = opts.seats ?? plan.included;
	const interval = opts.interval ?? 'month';
	const base = interval === 'year' ? plan.price_annual_minor : plan.price_monthly_minor;
	const total = base + Math.max(0, seats - plan.included) * (plan.extra_annual ?? 0);
	return {
		accountId: account,
		externalRef: null,
		eventCreated: new Date().toISOString(),
		invoice: {
			ref: `in_${randomUUID().replace(/-/g, '')}`,
			planCode: opts.planCode ?? 'pro',
			seats,
			interval,
			...period(opts.startMs ?? Date.now() - DAY, interval),
			totalMinor: total,
			currency: plan.currency.toLowerCase(),
			...over
		}
	};
}

beforeAll(async () => {
	const rows = (await asOwner(
		`SELECT code, price_monthly_minor, price_annual_minor, currency, coalesce((limits->>'seats_included')::int, 1) AS included,
		        (features->>'extra_seat_annual_minor')::int AS extra_annual FROM plan WHERE code IN ('pro', 'team')`
	)) as (Plan & { code: string })[];
	pro = rows.find((r) => r.code === 'pro')!;
	team = rows.find((r) => r.code === 'team')!;
});

afterAll(async () => {
	await asOwner('DELETE FROM billing_grant_log WHERE billing_account_id = ANY($1)', [accounts]);
	await asOwner('DELETE FROM subscription WHERE billing_account_id = ANY($1)', [accounts]);
	await asOwner('DELETE FROM billing_event WHERE account_id = ANY($1)', [accounts]);
});

describe('a paid B2B invoice (335)', () => {
	it('grants the invoiced plan for its period, once: a replay is a duplicate, the same invoice again is recorded only', async () => {
		const { user, account } = await personAccount('InvoiceGrantPerson');
		const p = paid(account);
		const id = `evt_${randomUUID().replace(/-/g, '')}`;
		expect(await apply('invoice.paid', p, id)).toBe('applied');
		expect(await outcome(id)).toBe('applied');
		expect(await subs(account)).toEqual([
			expect.objectContaining({
				provider: 'manual',
				external_ref: p.invoice.ref,
				plan_code: 'pro',
				status: 'active',
				seats: 1,
				billing_interval: 'month',
				cancel_at_period_end: true,
				period_start: new Date(p.invoice.periodStart),
				period_end: new Date(p.invoice.periodEnd)
			})
		]);
		expect(await log(account)).toEqual([{ action: 'grant', plan_code: 'pro', granted_by: 'invoice', reason: `invoice ${p.invoice.ref} paid` }]);
		// The person reads their plan as Pro (positive control for the read side).
		expect(await withUser(user.id, async (db) => (await db.query('SELECT app_account_plan($1) -> $2 ->> $3 AS v', [account, 'plan', 'code'])).rows[0]!.v)).toBe('pro');

		expect(await apply('invoice.paid', p, id)).toBe('duplicate');
		expect(await apply('invoice.paid', p)).toBe('recorded');
		// A late payment_failed on the same invoice: recorded, the grant stands.
		expect(await apply('invoice.payment_failed', { accountId: account, externalRef: null })).toBe('recorded');
		expect(await subs(account)).toHaveLength(1);
		expect((await subs(account))[0]).toMatchObject({ status: 'active', external_ref: p.invoice.ref });
		expect(await log(account)).toHaveLength(1);
	});

	it('a payment_failed arriving first changes nothing, and the paid one still grants', async () => {
		const { account } = await personAccount('InvoiceGrantOrder');
		expect(await apply('invoice.payment_failed', { accountId: account, externalRef: null })).toBe('recorded');
		expect(await subs(account)).toEqual([]);
		expect(await apply('invoice.paid', paid(account))).toBe('applied');
		expect(await subs(account)).toEqual([expect.objectContaining({ provider: 'manual', status: 'active' })]);
	});

	it('grants a team its invoiced seats for a year, priced with the extra seats', async () => {
		const account = await teamAccount('InvoiceGrantTeam');
		expect(await apply('invoice.paid', paid(account, {}, { plan: team, planCode: 'team', seats: team.included + 2, interval: 'year' }))).toBe('applied');
		expect(await subs(account)).toEqual([expect.objectContaining({ plan_code: 'team', seats: team.included + 2, billing_interval: 'year' })]);
	});

	it('refuses what doesn’t check out as a recorded conflict, writing nothing; the corrected invoice grants', async () => {
		const { account } = await personAccount('InvoiceGrantBad');
		const teamAcct = await teamAccount('InvoiceGrantBadTeam');
		const longAgo = Date.now() - 400 * DAY;
		const start = Date.now() - DAY;
		const cases: [string, unknown][] = [
			['a field that didn’t parse', paid(account, { seats: null })],
			['no ref', paid(account, { ref: null })],
			['a ref that isn’t an invoice id', paid(account, { ref: 'sub_x' })],
			['a fractional seat', paid(account, { seats: 1.5 })],
			['an unknown plan', paid(account, { planCode: 'agency' })],
			['Team on a person', paid(account, {}, { plan: team, planCode: 'team' })],
			['Pro on a team', paid(teamAcct)],
			['another currency', paid(account, { currency: 'usd' })],
			['a total below the price', paid(account, { totalMinor: pro.price_monthly_minor - 1 })],
			['a total as text', paid(account, { totalMinor: String(pro.price_monthly_minor) })],
			['a period already over', paid(account, {}, { startMs: longAgo })],
			['a period longer than its interval', paid(account, { periodEnd: new Date(start + 40 * DAY).toISOString() })],
			['an end before the start', paid(account, { periodEnd: new Date(start - DAY).toISOString() })],
			['a date that isn’t ISO', paid(account, { periodStart: 'yesterday' })],
			['an unknown interval', paid(account, { interval: 'week' })]
		];
		for (const [why, body] of cases) {
			const id = `evt_${randomUUID().replace(/-/g, '')}`;
			expect(await apply('invoice.paid', body, id), why).toBe('conflict');
			expect(await outcome(id), why).toBe('conflict');
		}
		expect(await subs(account)).toEqual([]);
		expect(await subs(teamAcct)).toEqual([]);
		expect(await log(account)).toEqual([]);
		// Positive control: the same invoice, as issued, grants; a total above the price is fine (the grant reads no amount).
		expect(await apply('invoice.paid', paid(account, { totalMinor: pro.price_monthly_minor + 100 }))).toBe('applied');
	});

	it('never ends a live card subscription or an open-ended grant', async () => {
		const { account } = await personAccount('InvoiceGrantCard');
		await asOwner(
			`INSERT INTO subscription (billing_account_id, plan_code, status, period_start, period_end, provider, external_ref) VALUES ($1, 'pro', 'active', now(), now() + interval '30 days', 'stripe', $2)`,
			[account, `sub_${randomUUID().replace(/-/g, '')}`]
		);
		expect(await apply('invoice.paid', paid(account))).toBe('conflict');
		expect(await subs(account)).toEqual([expect.objectContaining({ provider: 'stripe', status: 'active' })]);

		const { account: founder } = await personAccount('InvoiceGrantFounder');
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, period_start, provider) VALUES ($1, 'pro', 'active', now(), 'manual')`, [founder]);
		expect(await apply('invoice.paid', paid(founder))).toBe('conflict');
		expect(await subs(founder)).toEqual([expect.objectContaining({ provider: 'manual', external_ref: null, status: 'active', period_end: null })]);
	});

	it('a renewal paid before the period ends replaces the previous grant, the plan unbroken; an older invoice paid late is refused', async () => {
		const { account } = await personAccount('InvoiceGrantRenew');
		const first = paid(account);
		expect(await apply('invoice.paid', first)).toBe('applied');
		const next = paid(account, {}, { startMs: new Date(first.invoice.periodEnd).getTime() });
		expect(await apply('invoice.paid', next)).toBe('applied');
		const rows = await subs(account);
		expect(rows.find((r) => r.external_ref === first.invoice.ref)).toMatchObject({ status: 'canceled' });
		expect(rows.find((r) => r.external_ref === next.invoice.ref)).toMatchObject({ status: 'active', period_end: new Date(next.invoice.periodEnd) });
		expect((await log(account)).map((l) => [l.action, l.granted_by])).toEqual([
			['grant', 'invoice'],
			['revoke', 'invoice'],
			['grant', 'invoice']
		]);
		// An invoice for a period the live grant already reaches (paid after the renewal): refused, the renewal stands.
		expect(await apply('invoice.paid', paid(account))).toBe('conflict');
		expect((await subs(account)).filter((r) => r.status === 'active')).toEqual([expect.objectContaining({ external_ref: next.invoice.ref })]);
	});

	it('a subscription’s invoice, and an account we don’t know, still grant nothing', async () => {
		const { account } = await personAccount('InvoiceGrantSub');
		expect(await apply('invoice.paid', { accountId: account, externalRef: `sub_${randomUUID()}` })).toBe('recorded');
		expect(await subs(account)).toEqual([]);
		const ghost = randomUUID();
		const id = `evt_${randomUUID().replace(/-/g, '')}`;
		expect(await apply('invoice.paid', paid(ghost), id)).toBe('recorded');
		expect(await asOwner('SELECT 1 FROM subscription WHERE billing_account_id = $1', [ghost])).toEqual([]);
		await asOwner('DELETE FROM billing_event WHERE provider = $1 AND event_id = $2', ['stripe', id]);
	});
});
