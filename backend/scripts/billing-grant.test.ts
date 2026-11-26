// The staff grant script (pnpm dev:billing:grant, 330_staff_grant): what it takes and refuses.
// The grant itself is tested in src/billing/grant.db.test.ts.
import { describe, expect, it } from 'vitest';
import { isCalendarDate, parseArgs } from './billing-grant.js';

const T = '0f6f7c1e-3a52-4e3b-9d2a-6a1f0d1c2b3a';

describe('parseArgs', () => {
	it('takes a grant to a person or a team, in any order, with the operator’s login as who acts', () => {
		expect(parseArgs(['Lead@Example.com', 'Pro', '--until', '2027-03-31', '--reason', ' Founding user '], 'op')).toEqual({
			mode: 'grant',
			target: { kind: 'user', email: 'lead@example.com' },
			plan: 'pro',
			until: '2027-03-31',
			reason: 'Founding user',
			by: 'op',
			replace: false,
			seats: null
		});
		expect(parseArgs(['--reason', 'INV-1', '--replace', T.toUpperCase(), 'team', '--by', 'James'], 'op')).toEqual({
			mode: 'grant',
			target: { kind: 'team', teamId: T },
			plan: 'team',
			until: null,
			reason: 'INV-1',
			by: 'James',
			replace: true,
			seats: null
		});
	});

	it('takes --revoke with a reason, and --list alone', () => {
		expect(parseArgs(['a@example.com', '--revoke', '--reason', 'done'], 'op')).toEqual({ mode: 'revoke', target: { kind: 'user', email: 'a@example.com' }, reason: 'done', by: 'op' });
		expect(parseArgs([T, '--list'], 'op')).toEqual({ mode: 'list', target: { kind: 'team', teamId: T } });
	});

	it('needs a reason for a grant and a revoke', () => {
		expect(parseArgs(['a@example.com', 'pro'], 'op')).toMatch(/--reason/);
		expect(parseArgs(['a@example.com', 'pro', '--reason', '   '], 'op')).toMatch(/--reason/);
		expect(parseArgs(['a@example.com', '--revoke'], 'op')).toMatch(/--reason/);
		expect(parseArgs(['a@example.com', 'pro', '--reason', 'x'.repeat(501)], 'op')).toMatch(/500/);
	});

	it('refuses a bad target, date, option or combination', () => {
		expect(parseArgs([], 'op')).toMatch(/email address or the team/);
		expect(parseArgs(['nobody', 'pro', '--reason', 'x'], 'op')).toMatch(/uuid/);
		expect(parseArgs(['a@example.com', '--reason', 'x'], 'op')).toMatch(/plan/);
		expect(parseArgs(['a@example.com', 'pro', 'extra', '--reason', 'x'], 'op')).toMatch(/unexpected argument extra/);
		expect(parseArgs(['a@example.com', 'pro', '--until', '31/03/2027', '--reason', 'x'], 'op')).toMatch(/YYYY-MM-DD/);
		expect(parseArgs(['a@example.com', 'pro', '--until', '2027-02-30', '--reason', 'x'], 'op')).toMatch(/YYYY-MM-DD/);
		expect(parseArgs(['a@example.com', 'pro', '--until', '--reason', 'x'], 'op')).toMatch(/--until needs a value/);
		expect(parseArgs(['a@example.com', 'pro', '--reason', 'x', '--force'], 'op')).toMatch(/unknown option --force/);
		expect(parseArgs(['a@example.com', '--revoke', '--list'], 'op')).toMatch(/one of/);
		expect(parseArgs(['a@example.com', 'pro', '--revoke', '--reason', 'x'], 'op')).toMatch(/unexpected argument pro/);
		expect(parseArgs(['a@example.com', '--revoke', '--replace', '--reason', 'x'], 'op')).toMatch(/no --until or --replace/);
		expect(parseArgs(['a@example.com', '--list', '--reason', 'x'], 'op')).toMatch(/--list takes only/);
		expect(parseArgs(['a@example.com', 'pro', '--reason', 'x'], '')).toMatch(/--by/);
	});
});

describe('isCalendarDate', () => {
	it('takes real dates only', () => {
		expect(isCalendarDate('2028-02-29')).toBe(true);
		expect(isCalendarDate('2027-02-29')).toBe(false);
		expect(isCalendarDate('2027-13-01')).toBe(false);
		expect(isCalendarDate('2027-1-01')).toBe(false);
	});
});
