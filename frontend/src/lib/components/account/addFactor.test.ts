import { describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import { needsStepUpToAdd, setupRefusal } from './addFactor';

describe('needsStepUpToAdd', () => {
	it('the first way needs only the password, whatever the session', () => {
		expect(needsStepUpToAdd({ methods: [], sessionVerified: false }, 'totp')).toBe(false);
		expect(needsStepUpToAdd({ methods: [], sessionVerified: false }, 'email')).toBe(false);
	});

	it('a second way from a password-only session needs a sign-in with a code', () => {
		expect(needsStepUpToAdd({ methods: ['email'], sessionVerified: false }, 'totp')).toBe(true);
		expect(needsStepUpToAdd({ methods: ['totp'], sessionVerified: false }, 'email')).toBe(true);
	});

	it('a session that gave a code adds the second way (positive control)', () => {
		expect(needsStepUpToAdd({ methods: ['email'], sessionVerified: true }, 'totp')).toBe(false);
		expect(needsStepUpToAdd({ methods: ['totp'], sessionVerified: true }, 'email')).toBe(false);
	});

	it('a way already on is not the step-up’s to refuse, and an unread status asks nothing', () => {
		expect(needsStepUpToAdd({ methods: ['totp'], sessionVerified: false }, 'totp')).toBe(false);
		expect(needsStepUpToAdd(null, 'totp')).toBe(false);
	});
});

describe('setupRefusal', () => {
	it('403 mfa_step_up is the sign-in-again refusal, not a wrong password', () => {
		expect(setupRefusal(new ApiError(403, 'x', undefined, 'mfa_step_up'))).toBe('step-up');
	});

	it('the enrol’s other 403 is the wrong password', () => {
		expect(setupRefusal(new ApiError(403, 'x', undefined, 'wrong_current_password'))).toBe('wrong-password');
		expect(setupRefusal(new ApiError(403, 'x'))).toBe('wrong-password');
	});

	it('anything else is worded from its code', () => {
		expect(setupRefusal(new ApiError(429, 'x', undefined, 'signin_locked'))).toBe('other');
		expect(setupRefusal(new ApiError(400, 'x', undefined, 'mfa_step_up'))).toBe('other');
		expect(setupRefusal(new Error('network'))).toBe('other');
		expect(setupRefusal(undefined)).toBe('other');
	});
});
