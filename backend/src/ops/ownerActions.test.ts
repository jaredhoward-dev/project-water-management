// The owner actions' event schemas and error codes (ops/ownerActions.ts;
// docs/deployment.md § Owner actions): each action takes exactly its fields,
// anything else is refused before anything connects, and a failure's public
// form is a code and a fixed reason, never the database's text.
import { describe, expect, it } from 'vitest';
import { StaffGrantError } from '../billing/staffGrant.js';
import { NoPersonError } from '../projects/authorityConfirm.js';
import { InvoiceError } from '../billing/invoice.js';
import { BillingProviderError, BillingUnavailableError } from '../billing/provider.js';
import { buildPayload } from '../../../scripts/release/owner-action.mjs';
import { OwnerActionError, ownerActionCode, ownerActionReason, OWNER_ACTIONS, parseOwnerAction, WORKFLOW_ACTIONS } from './ownerActions.js';

const TEAM = '0b0e7f4e-2f7c-4a43-9d55-3f1f7a8f1c01';
const PROJECT = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const refused = (event: unknown) => {
	try {
		parseOwnerAction(event);
		return 'parsed';
	} catch (e) {
		return (e as OwnerActionError).code;
	}
};

describe('parseOwnerAction', () => {
	it('takes each action with its fields, lowercasing addresses and ids and trimming text', () => {
		expect(parseOwnerAction({ action: 'billing-grant', email: ' Someone@Example.org ', plan: 'team', until: '2026-12-31', reason: ' PO 7 ', by: 'octocat' })).toEqual({
			action: 'billing-grant',
			email: 'someone@example.org',
			plan: 'team',
			until: '2026-12-31',
			reason: 'PO 7',
			by: 'octocat'
		});
		expect(parseOwnerAction({ action: 'billing-grant', teamId: TEAM.toUpperCase(), plan: 'pro', until: null, reason: 'Founding', by: 'x', replace: true })).toMatchObject({
			teamId: TEAM,
			replace: true
		});
		expect(parseOwnerAction({ action: 'billing-revoke', teamId: TEAM, reason: 'ended', by: 'x' })).toMatchObject({ action: 'billing-revoke' });
		expect(parseOwnerAction({ action: 'billing-grants' })).toEqual({ action: 'billing-grants' });
		expect(parseOwnerAction({ action: 'billing-grants', teamId: TEAM })).toEqual({ action: 'billing-grants', teamId: TEAM });
		expect(parseOwnerAction({ action: 'billing-report', month: '2026-11' })).toEqual({ action: 'billing-report', month: '2026-11' });
		expect(parseOwnerAction({ action: 'billing-report' })).toEqual({ action: 'billing-report' });
		expect(parseOwnerAction({ action: 'authority-confirm', projectId: PROJECT, email: 'a@b.org', reference: 'CMA letter' })).toMatchObject({ action: 'authority-confirm' });
	});

	it('refuses an unknown action, an unknown or missing field, and SQL', () => {
		expect(refused({ action: 'billing-delete' })).toBe('refused');
		expect(refused({ action: 'billing-report', sql: 'SELECT 1' })).toBe('refused');
		expect(refused({ action: 'billing-report', month: '2026-13' })).toBe('refused');
		expect(refused({ action: 'billing-report', month: '2026-11', showEmails: true })).toBe('refused');
		expect(refused({ action: 'billing-grant', email: 'a@b.org', plan: 'team', by: 'x' })).toBe('refused'); // no reason
		expect(refused({ action: 'billing-grant', email: 'a@b.org', plan: 'team', reason: ' ', by: 'x' })).toBe('refused');
		expect(refused({ action: 'billing-grant', email: 'a@b.org', plan: 'team', reason: 'r', by: 'x'.repeat(101) })).toBe('refused');
		expect(refused({ action: 'billing-grant', email: 'a@b.org', plan: 'team', reason: 'r'.repeat(501), by: 'x' })).toBe('refused');
		expect(refused({ action: 'billing-grant', email: 'a@b.org', plan: 'free', reason: 'r', by: 'x' })).toBe('refused');
		expect(refused({ action: 'billing-grant', email: 'a@b.org', plan: 'team', until: '2026-02-30', reason: 'r', by: 'x' })).toBe('refused');
		expect(refused({ action: 'billing-grant', email: 'a@b.org', plan: 'team', reason: 'r', by: 'x', replace: 'yes' })).toBe('refused');
		expect(refused({ action: 'billing-revoke', reason: 'r', by: 'x' })).toBe('refused'); // nobody named
		expect(refused({ action: 'billing-revoke', email: 'a@b.org', teamId: TEAM, reason: 'r', by: 'x' })).toBe('refused'); // both
		expect(refused({ action: 'billing-revoke', email: 'a@b.org', reason: 'r', by: 'x', plan: 'pro' })).toBe('refused');
		expect(refused({ action: 'billing-grants', email: 'a@b.org', teamId: TEAM })).toBe('refused');
		expect(refused({ action: 'billing-grants', teamId: 'not-a-uuid' })).toBe('refused');
		expect(refused({ action: 'billing-grants', email: 'not an address' })).toBe('refused');
		expect(refused({ action: 'authority-confirm', projectId: PROJECT, email: 'a@b.org', reference: 'r'.repeat(201) })).toBe('refused');
		expect(refused(null)).toBe('refused');
	});

	it('never echoes a value in the refusal (its message is for CloudWatch, and still names fields only)', () => {
		try {
			parseOwnerAction({ action: 'billing-grant', email: 'secret-person@example.org', plan: 'gold', reason: 'r', by: 'x' });
			expect.unreachable();
		} catch (e) {
			expect((e as Error).message).not.toContain('secret-person');
			expect((e as Error).message).toContain('plan');
		}
	});
});

describe('ids only from the workflow (its runs are in a public repo)', () => {
	const ACCOUNT = '5c4d3e2f-1a0b-4c9d-8e7f-6a5b4c3d2e1f';
	const PERSON = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b';

	it('takes each workflow payload naming an account, a person, a team or a project by id', () => {
		expect(parseOwnerAction({ action: 'billing-grant', via: 'workflow', accountId: ACCOUNT.toUpperCase(), plan: 'team', reason: 'PO 7', by: 'octocat', replace: false })).toMatchObject({
			accountId: ACCOUNT,
			via: 'workflow'
		});
		expect(parseOwnerAction({ action: 'billing-grant', via: 'workflow', userId: PERSON, plan: 'pro', reason: 'Founding', by: 'octocat', replace: false })).toMatchObject({ userId: PERSON });
		expect(parseOwnerAction({ action: 'billing-revoke', via: 'workflow', teamId: TEAM, reason: 'ended', by: 'octocat' })).toMatchObject({ teamId: TEAM });
		expect(parseOwnerAction({ action: 'billing-grants', via: 'workflow', accountId: ACCOUNT })).toEqual({ action: 'billing-grants', via: 'workflow', accountId: ACCOUNT });
		expect(parseOwnerAction({ action: 'billing-grants', via: 'workflow' })).toEqual({ action: 'billing-grants', via: 'workflow' });
		expect(parseOwnerAction({ action: 'billing-report', via: 'workflow', month: '2026-11' })).toMatchObject({ action: 'billing-report' });
		expect(parseOwnerAction({ action: 'authority-confirm', via: 'workflow', projectId: PROJECT, userId: PERSON, reference: 'CMA letter' })).toEqual({
			action: 'authority-confirm',
			via: 'workflow',
			projectId: PROJECT,
			userId: PERSON,
			reference: 'CMA letter'
		});
	});

	it('refuses a workflow payload that carries an address, whatever else it names', () => {
		expect(refused({ action: 'billing-grant', via: 'workflow', email: 'a@b.org', plan: 'team', reason: 'r', by: 'x' })).toBe('refused');
		expect(refused({ action: 'billing-revoke', via: 'workflow', email: 'a@b.org', reason: 'r', by: 'x' })).toBe('refused');
		expect(refused({ action: 'billing-grants', via: 'workflow', email: 'a@b.org' })).toBe('refused');
		expect(refused({ action: 'authority-confirm', via: 'workflow', projectId: PROJECT, email: 'a@b.org', reference: 'r' })).toBe('refused');
		// The address beside an id is two targets, refused too.
		expect(refused({ action: 'billing-grants', via: 'workflow', accountId: ACCOUNT, email: 'a@b.org' })).toBe('refused');
		expect(refused({ action: 'billing-grant', via: 'workflow', accountId: ACCOUNT, email: 'a@b.org', plan: 'team', reason: 'r', by: 'x' })).toBe('refused');
		// The same payloads without the mark are the operator's direct invoke, which may name an address.
		expect(parseOwnerAction({ action: 'billing-grants', email: 'a@b.org' })).toEqual({ action: 'billing-grants', email: 'a@b.org' });
		expect(parseOwnerAction({ action: 'authority-confirm', projectId: PROJECT, email: 'a@b.org', reference: 'r' })).toMatchObject({ email: 'a@b.org' });
	});

	it('refuses the address lookup from the workflow, and a mark other than workflow', () => {
		expect(refused({ action: 'billing-account', via: 'workflow', userId: PERSON })).toBe('refused');
		expect(refused({ action: 'billing-account', via: 'workflow', email: 'a@b.org' })).toBe('refused');
		expect(refused({ action: 'billing-report', via: 'operator' })).toBe('refused');
	});

	it('names exactly one target, each id a uuid', () => {
		expect(refused({ action: 'billing-grant', accountId: ACCOUNT, teamId: TEAM, plan: 'team', reason: 'r', by: 'x' })).toBe('refused');
		expect(refused({ action: 'billing-revoke', userId: PERSON, accountId: ACCOUNT, reason: 'r', by: 'x' })).toBe('refused');
		expect(refused({ action: 'billing-grants', accountId: 'acct_123' })).toBe('refused');
		expect(refused({ action: 'billing-grants', userId: 'a@b.org' })).toBe('refused');
		expect(refused({ action: 'authority-confirm', projectId: PROJECT, reference: 'r' })).toBe('refused'); // nobody
		expect(refused({ action: 'authority-confirm', projectId: PROJECT, userId: PERSON, email: 'a@b.org', reference: 'r' })).toBe('refused'); // both
		expect(refused({ action: 'authority-confirm', projectId: PROJECT, userId: 'not-a-uuid', reference: 'r' })).toBe('refused');
	});

	it('looks an account up by address, person or team: exactly one, and nothing else', () => {
		expect(parseOwnerAction({ action: 'billing-account', email: ' Someone@Example.org ' })).toEqual({ action: 'billing-account', email: 'someone@example.org' });
		expect(parseOwnerAction({ action: 'billing-account', userId: PERSON })).toEqual({ action: 'billing-account', userId: PERSON });
		expect(parseOwnerAction({ action: 'billing-account', teamId: TEAM })).toEqual({ action: 'billing-account', teamId: TEAM });
		expect(refused({ action: 'billing-account' })).toBe('refused');
		expect(refused({ action: 'billing-account', email: 'a@b.org', teamId: TEAM })).toBe('refused');
		expect(refused({ action: 'billing-account', accountId: ACCOUNT })).toBe('refused');
		expect(refused({ action: 'billing-account', email: 'a@b.org', plan: 'pro' })).toBe('refused');
	});

	it('accepts every payload the workflow builds (scripts/release/owner-action.mjs), and the workflow offers no other action', () => {
		const blank = { account_id: '', user_id: '', team_id: '', plan: 'none', until: '', replace: false, reason: '', month: '', project_id: '', reference: '' };
		const cases: Record<string, unknown>[] = [
			{ action: 'billing-grant', account_id: ACCOUNT, plan: 'team', until: '2027-01-31', reason: 'Invoice INV-0042' },
			{ action: 'billing-grant', user_id: PERSON, plan: 'pro', reason: 'Founding user', replace: true },
			{ action: 'billing-revoke', team_id: TEAM, reason: 'Pilot ended' },
			{ action: 'billing-grants' },
			{ action: 'billing-grants', account_id: ACCOUNT },
			{ action: 'billing-report', month: '2026-11' },
			{ action: 'authority-confirm', project_id: PROJECT, user_id: PERSON, reference: 'CMA letter' }
		];
		for (const inputs of cases) {
			const built = buildPayload({ ...blank, ...inputs }, 'octocat');
			if (!('payload' in built)) throw new Error(`the workflow refused ${JSON.stringify(inputs)}: ${built.errors.join('; ')}`);
			expect(parseOwnerAction(built.payload)).toMatchObject({ action: inputs.action, via: 'workflow' });
		}
		// Not the address lookup, and not the invoice: its PO number may identify the client.
		expect([...WORKFLOW_ACTIONS].sort()).toEqual(OWNER_ACTIONS.filter((a) => a !== 'billing-account' && a !== 'billing-invoice').sort());
	});

	it('never echoes the address of a refused workflow payload', () => {
		try {
			parseOwnerAction({ action: 'billing-grants', via: 'workflow', email: 'secret-person@example.org' });
			expect.unreachable();
		} catch (e) {
			expect((e as Error).message).not.toContain('secret-person');
		}
	});
});

describe('ownerActionCode', () => {
	it('maps each refusal to a code, never its text', () => {
		expect(ownerActionCode(new StaffGrantError('no account with the address a@b.org', 'no_person'))).toBe('no_person');
		expect(ownerActionCode(new NoPersonError('a@b.org'))).toBe('no_person');
		expect(ownerActionCode(Object.assign(new Error('live Stripe'), { code: '23505' }))).toBe('live_subscription');
		expect(ownerActionCode(Object.assign(new Error('no live grant'), { code: 'P0002' }))).toBe('no_live_grant');
		expect(ownerActionCode(Object.assign(new Error('bad plan'), { code: '22023' }))).toBe('invalid');
		expect(ownerActionCode(Object.assign(new Error('not an editor'), { code: '23514' }))).toBe('not_editor');
		expect(ownerActionCode(new Error('connect ECONNREFUSED'))).toBe('action_failed');
		expect(ownerActionCode(new InvoiceError('the PO number is …', 'invalid'))).toBe('invalid');
		expect(ownerActionCode(new InvoiceError('live Stripe', 'live_subscription'))).toBe('live_subscription');
		expect(ownerActionCode(new BillingUnavailableError())).toBe('billing_unavailable');
		expect(ownerActionCode(new BillingProviderError())).toBe('billing_provider_error');
		for (const code of ['refused', 'no_person', 'live_subscription', 'action_failed', 'billing_unavailable', 'billing_provider_error'] as const) expect(ownerActionReason(code)).not.toMatch(/@/);
	});
});

describe('billing-invoice (direct invoke only)', () => {
	const ACCOUNT = '5c4d3e2f-1a0b-4c9d-8e7f-6a5b4c3d2e1f';
	const ok = { action: 'billing-invoice', teamId: TEAM, plan: 'team', interval: 'year', poNumber: ' PO-2026/0042 ' };

	it('takes a team, a person or an account by id, a plan, an interval, optional seats and start, and a PO number (trimmed)', () => {
		expect(parseOwnerAction(ok)).toEqual({ ...ok, poNumber: 'PO-2026/0042' });
		expect(parseOwnerAction({ ...ok, teamId: undefined, accountId: ACCOUNT, seats: 5, from: '2027-01-01' })).toMatchObject({ accountId: ACCOUNT, seats: 5, from: '2027-01-01' });
		expect(parseOwnerAction({ ...ok, teamId: undefined, email: 'Billing@Example.org', plan: 'pro', interval: 'month' })).toMatchObject({ email: 'billing@example.org' });
	});

	it('refuses the workflow’s mark outright, and a bad PO number, seats, interval, date or target', () => {
		expect(refused({ ...ok, via: 'workflow' })).toBe('refused');
		for (const poNumber of ['', 'PO<1>', 'PO\n1', 'x'.repeat(65), 'a@b.org']) expect(refused({ ...ok, poNumber }), poNumber).toBe('refused');
		expect(refused({ ...ok, poNumber: undefined })).toBe('refused');
		expect(refused({ ...ok, seats: 0 })).toBe('refused');
		expect(refused({ ...ok, seats: 51 })).toBe('refused');
		expect(refused({ ...ok, interval: 'week' })).toBe('refused');
		expect(refused({ ...ok, from: '2027-02-30' })).toBe('refused');
		expect(refused({ ...ok, plan: 'free' })).toBe('refused');
		expect(refused({ ...ok, accountId: ACCOUNT })).toBe('refused'); // two targets
		expect(refused({ ...ok, amountMinor: 1 })).toBe('refused'); // the price is the plan table's
	});
});
