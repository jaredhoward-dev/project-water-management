// The staff tool's B2B invoice against Postgres (billing/invoice.ts; the local
// script scripts/billing-invoice.ts and the migrate Lambda's billing-invoice
// owner action). The provider is the mock, or a recording stand-in that
// makes a customer as Stripe's does: no network. What the database gives the
// invoice (the plan table's price, the account, its customer) and what it
// refuses (a live Stripe subscription, the wrong plan for the kind). Runs
// under the workspace's skewed TZ (CLAUDE.md rule 7): the period is SAST days.
import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { OWNER_URL } from '../__tests__/test-db.js';
import { ownerAction } from '../lambda-migrate.js';
import { issueInvoice } from './invoice.js';
import { billingProvider, type BillingProvider, type InvoiceRequest as ProviderInvoiceRequest } from './provider.js';
import { parseArgs, runInvoice } from '../../scripts/billing-invoice.js';

const context = { logGroupName: '/aws/lambda/wm-migrate', logStreamName: 'stream', awsRequestId: 'req-1' };
const mock = billingProvider({ BILLING_PROVIDER: 'mock', BILLING_WEBHOOK_SECRET: 'dev-only-test' })!;

/** A provider that records what it was asked and makes a customer when the account has none, as Stripe's does. */
function recording(): BillingProvider & { asked: ProviderInvoiceRequest[] } {
	const asked: ProviderInvoiceRequest[] = [];
	return {
		...mock,
		asked,
		async createInvoice(req) {
			asked.push(req);
			const r = await mock.createInvoice(req);
			return req.account.customerRef ? r : { ...r, newCustomerRef: `cus_Test${req.account.id.replace(/-/g, '').slice(0, 12)}` };
		}
	};
}
const withOwner = async <T>(f: (c: pg.Client) => Promise<T>): Promise<T> => {
	const c = new pg.Client({ connectionString: OWNER_URL });
	await c.connect();
	try {
		return await f(c);
	} finally {
		await c.end();
	}
};

describe('issueInvoice', () => {
	it('invoices a team for Team at the plan table’s annual price, extra seats as a second line, and stores the customer the provider made', async () => {
		const admin = await signUp('InvoiceTeamAdmin');
		const teamId = (await admin.call('POST', '/teams', { name: 'Invoice WUA' })).body.team.id as string;
		const p = recording();
		const r = await withOwner((c) => issueInvoice(c, p, { target: { kind: 'team', teamId }, plan: 'team', interval: 'year', seats: 5, from: '2027-01-01', poNumber: 'PO-2026/0042' }));
		const [acct] = (await asOwner('SELECT id, external_customer_ref FROM billing_account WHERE team_id = $1', [teamId])) as { id: string; external_customer_ref: string | null }[];
		expect(r).toMatchObject({ kind: 'team', ownerId: teamId, accountId: acct!.id, plan: 'team', seats: 5, from: '2027-01-01', until: '2027-12-31' });
		const [plan] = (await asOwner(`SELECT price_annual_minor, features->>'extra_seat_annual_minor' AS extra FROM plan WHERE code = 'team'`)) as { price_annual_minor: number; extra: string }[];
		expect(p.asked[0]!.lines.map((l) => l.amountMinor)).toEqual([Number(plan!.price_annual_minor), 2 * Number(plan!.extra)]);
		expect(p.asked[0]).toMatchObject({ planCode: 'team', poNumber: 'PO-2026/0042', account: { id: acct!.id, customerRef: null } });
		expect(r.invoice.totalMinor).toBe(Number(plan!.price_annual_minor) + 2 * Number(plan!.extra));
		expect(acct!.external_customer_ref).toMatch(/^cus_Test/);
		// Again: the stored customer, the same key, the same mock invoice; nothing granted by issuing.
		const again = await withOwner((c) => issueInvoice(c, p, { target: { kind: 'team', teamId }, plan: 'team', interval: 'year', seats: 5, from: '2027-01-01', poNumber: 'PO-2026/0042' }));
		expect(p.asked[1]).toMatchObject({ account: { customerRef: acct!.external_customer_ref }, key: p.asked[0]!.key });
		expect(again.invoice.invoiceId).toBe(r.invoice.invoiceId);
		expect(await asOwner('SELECT 1 FROM subscription WHERE billing_account_id = $1', [acct!.id])).toEqual([]);
	});

	it('refuses Team for a person and Pro for a team, and extra seats on Pro, before the provider is asked', async () => {
		const person = await signUp('InvoiceWrongPlan');
		const p = recording();
		await expect(withOwner((c) => issueInvoice(c, p, { target: { kind: 'user', email: person.email }, plan: 'team', interval: 'month', poNumber: 'PO1' }))).rejects.toMatchObject({ code: 'invalid' });
		await expect(withOwner((c) => issueInvoice(c, p, { target: { kind: 'user', email: person.email }, plan: 'pro', interval: 'month', seats: 2, poNumber: 'PO1' }))).rejects.toMatchObject({ code: 'invalid' });
		expect(p.asked).toEqual([]);
		// Positive control: Pro for the person goes through.
		await expect(withOwner((c) => issueInvoice(c, p, { target: { kind: 'user', email: person.email }, plan: 'pro', interval: 'month', poNumber: 'PO1' }))).resolves.toMatchObject({ plan: 'pro', seats: 1 });
	});

	it('refuses an account with a live Stripe subscription (it already pays by card)', async () => {
		const person = await signUp('InvoiceStripeLive');
		const account = (await person.call('GET', '/account/plan')).body.account.id as string;
		await asOwner(
			`INSERT INTO subscription (billing_account_id, plan_code, status, period_start, period_end, provider, external_ref) VALUES ($1, 'pro', 'active', now(), now() + interval '30 days', 'stripe', $2)`,
			[account, `sub_${crypto.randomUUID().replace(/-/g, '')}`]
		);
		const p = recording();
		await expect(withOwner((c) => issueInvoice(c, p, { target: { kind: 'account', accountId: account }, plan: 'pro', interval: 'year', poNumber: 'PO1' }))).rejects.toMatchObject({ code: 'live_subscription' });
		expect(p.asked).toEqual([]);
	});
});

describe('the local script and the Lambda action', () => {
	it('the script invoices through the mock by default and says paying it grants the plan', async () => {
		const person = await signUp('InvoiceScript');
		const args = parseArgs([person.email, 'pro', '--interval', 'month', '--po', 'PO 77', '--from', '2027-03-31']);
		if (typeof args === 'string') throw new Error(args);
		const lines = await runInvoice(OWNER_URL, args, { BILLING_WEBHOOK_SECRET: 'dev-only-test' });
		expect(lines[0]).toMatch(/^Invoiced .* \(mock\): in_mock_\w+ .*pro × 1 seats, 2027-03-31 to 2027-04-29/);
		expect(lines[1]).toBe('Once it is paid, its invoice.paid grants pro until 2027-04-29 through the webhook (docs/billing.md § B2B invoices).');
		const account = (await person.call('GET', '/account/plan')).body.account.id as string;
		expect(await asOwner('SELECT 1 FROM subscription WHERE billing_account_id = $1', [account])).toEqual([]);
	});

	it('--paid: the mock’s invoice.paid through the real webhook route grants the invoiced plan for its period (335), once', async () => {
		vi.stubEnv('BILLING_PROVIDER', 'mock');
		vi.stubEnv('BILLING_WEBHOOK_SECRET', 'dev-only-test');
		try {
			const admin = await signUp('InvoicePaidTeam');
			const teamId = (await admin.call('POST', '/teams', { name: 'Invoice Paid WUA' })).body.team.id as string;
			const today = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
			const args = parseArgs([teamId, 'team', '--interval', 'year', '--po', 'PO-5', '--seats', '5', '--from', today, '--paid']);
			if (typeof args === 'string') throw new Error(args);
			const lines = await runInvoice(OWNER_URL, args, process.env);
			expect(lines[1]).toMatch(/^Paid \(mock\): team granted until \d{4}-\d{2}-\d{2} through the webhook\.$/);
			const rows = (await asOwner(
				`SELECT s.provider, s.external_ref, s.plan_code, s.status, s.seats, s.billing_interval FROM subscription s JOIN billing_account a ON a.id = s.billing_account_id WHERE a.team_id = $1`,
				[teamId]
			)) as { provider: string; external_ref: string }[];
			expect(rows).toEqual([expect.objectContaining({ provider: 'manual', plan_code: 'team', status: 'active', seats: 5, billing_interval: 'year' })]);
			expect(rows[0]!.external_ref).toMatch(/^in_mock_/);
			// The team's admin reads Team on its plan page.
			expect((await admin.call('GET', `/teams/${teamId}/plan`)).body.plan.code).toBe('team');
			// Paid again (the same key, the same mock invoice): nothing more is granted.
			await runInvoice(OWNER_URL, args, process.env);
			expect(await asOwner('SELECT 1 FROM subscription s JOIN billing_account a ON a.id = s.billing_account_id WHERE a.team_id = $1', [teamId])).toHaveLength(1);
			// --paid is the mock's alone.
			await expect(runInvoice(OWNER_URL, args, { BILLING_PROVIDER: 'manual' })).rejects.toThrow(/--paid is the mock/);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it('the script refuses under manual (its invoices are sent from Stripe’s dashboard)', async () => {
		const person = await signUp('InvoiceManual');
		const args = parseArgs([person.email, 'pro', '--interval', 'year', '--po', 'PO1']);
		if (typeof args === 'string') throw new Error(args);
		await expect(runInvoice(OWNER_URL, args, { BILLING_PROVIDER: 'manual' })).rejects.toMatchObject({ code: 'billing_unavailable' });
	});

	it('the Lambda answers billing_unavailable without BILLING_PROVIDER=stripe (never the mock in production), before it writes anything', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const admin = await signUp('InvoiceLambda');
		const teamId = (await admin.call('POST', '/teams', { name: 'Invoice Lambda WUA' })).body.team.id as string;
		const prev = process.env.BILLING_PROVIDER;
		delete process.env.BILLING_PROVIDER;
		try {
			const err = (await ownerAction({ action: 'billing-invoice', teamId, plan: 'team', interval: 'year', poNumber: 'PO-9' }, context, async () => OWNER_URL).catch((e: Error) => e)) as Error;
			const failure = JSON.parse(err.message) as { code: string };
			expect(failure.code).toBe('billing_unavailable');
			expect(err.message).not.toContain('PO-9');
		} finally {
			if (prev !== undefined) process.env.BILLING_PROVIDER = prev;
		}
		expect(await asOwner('SELECT 1 FROM billing_account WHERE team_id = $1', [teamId])).toEqual([]);
	});
});

describe('parseArgs', () => {
	it('takes a team id or an address, the plan, the interval and the PO number; refuses what’s missing', () => {
		expect(parseArgs(['0B0E7F4E-2F7C-4A43-9D55-3F1F7A8F1C01', 'Team', '--interval', 'year', '--po', ' PO-1 ', '--seats', '4'])).toEqual({
			target: { kind: 'team', teamId: '0b0e7f4e-2f7c-4a43-9d55-3f1f7a8f1c01' },
			plan: 'team',
			interval: 'year',
			poNumber: 'PO-1',
			seats: 4,
			from: null
		});
		expect(parseArgs(['a@b.org', 'pro', '--po', 'PO1'])).toMatch(/--interval/);
		expect(parseArgs(['a@b.org', 'pro', '--interval', 'year'])).toMatch(/--po/);
		expect(parseArgs(['a@b.org', 'pro', '--interval', 'year', '--po', 'PO1', '--seats', '2.5'])).toMatch(/whole number/);
		expect(parseArgs(['someone', 'pro'])).toMatch(/uuid/);
		expect(parseArgs(['a@b.org', 'pro', '--amount', '1'])).toMatch(/unknown option/);
		expect(parseArgs(['a@b.org', 'pro', '--interval', 'year', '--po', 'PO1', '--paid'])).toMatchObject({ paid: true });
	});
});
