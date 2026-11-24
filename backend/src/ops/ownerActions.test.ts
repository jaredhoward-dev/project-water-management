// The owner actions' event schemas and error codes (ops/ownerActions.ts;
// docs/deployment.md § Owner actions): each action takes exactly its fields,
// anything else is refused before anything connects, and a failure's public
// form is a code and a fixed reason, never the database's text.
import { describe, expect, it } from 'vitest';
import { StaffGrantError } from '../billing/staffGrant.js';
import { NoPersonError } from '../projects/authorityConfirm.js';
import { OwnerActionError, ownerActionCode, ownerActionReason, parseOwnerAction } from './ownerActions.js';

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

describe('ownerActionCode', () => {
	it('maps each refusal to a code, never its text', () => {
		expect(ownerActionCode(new StaffGrantError('no account with the address a@b.org', 'no_person'))).toBe('no_person');
		expect(ownerActionCode(new NoPersonError('a@b.org'))).toBe('no_person');
		expect(ownerActionCode(Object.assign(new Error('live Stripe'), { code: '23505' }))).toBe('live_subscription');
		expect(ownerActionCode(Object.assign(new Error('no live grant'), { code: 'P0002' }))).toBe('no_live_grant');
		expect(ownerActionCode(Object.assign(new Error('bad plan'), { code: '22023' }))).toBe('invalid');
		expect(ownerActionCode(Object.assign(new Error('not an editor'), { code: '23514' }))).toBe('not_editor');
		expect(ownerActionCode(new Error('connect ECONNREFUSED'))).toBe('action_failed');
		for (const code of ['refused', 'no_person', 'live_subscription', 'action_failed'] as const) expect(ownerActionReason(code)).not.toMatch(/@/);
	});
});
