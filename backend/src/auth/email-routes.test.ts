// Confirming an address leaves invites pending only for 334's seat guard
// (auth/email-routes.ts markVerified): isPlanLimit must match that refusal
// and nothing else, or another failure would be swallowed.
import { describe, expect, it } from 'vitest';
import { isPlanLimit } from './email-routes.js';

const pgError = (code: string, constraint?: string) => Object.assign(new Error('refused'), { code, constraint });

describe('isPlanLimit', () => {
	it('matches the seat guard: SQLSTATE 23514 with constraint plan_limit', () => {
		expect(isPlanLimit(pgError('23514', 'plan_limit'))).toBe(true);
	});

	it('refuses another check constraint under 23514', () => {
		expect(isPlanLimit(pgError('23514', 'app_plan_limits_valid'))).toBe(false);
		expect(isPlanLimit(pgError('23514'))).toBe(false);
	});

	it('refuses plan_limit under another SQLSTATE', () => {
		expect(isPlanLimit(pgError('23505', 'plan_limit'))).toBe(false);
		expect(isPlanLimit(pgError('P0001', 'plan_limit'))).toBe(false);
	});

	it('refuses anything without a code', () => {
		expect(isPlanLimit(new Error('boom'))).toBe(false);
		expect(isPlanLimit({})).toBe(false);
	});
});
