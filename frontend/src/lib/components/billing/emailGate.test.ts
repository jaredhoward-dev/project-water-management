import { describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import { emailGateCode, emailGateText } from './emailGate';

describe('emailGateCode (343_free_email_gate)', () => {
	it('is the 403 email_unverified or email_disposable refusal, not another 403 or another error', () => {
		expect(emailGateCode(new ApiError(403, 'x', undefined, 'email_unverified'))).toBe('email_unverified');
		expect(emailGateCode(new ApiError(403, 'x', undefined, 'email_disposable'))).toBe('email_disposable');
		expect(emailGateCode(new ApiError(403, 'x'))).toBeNull();
		expect(emailGateCode(new ApiError(402, 'x', undefined, 'plan_limit'))).toBeNull();
		expect(emailGateCode(new Error('email_unverified'))).toBeNull();
	});
});

describe('emailGateText', () => {
	it('is #641’s unverified copy, with the signed-in person’s address', () => {
		expect(emailGateText('email_unverified', 'assistant', 'name@example.com')).toBe(
			'Verify your email to use the assistant. We sent a link to name@example.com.'
		);
		expect(emailGateText('email_unverified', 'feeds', null)).toBe('Verify your email to switch on a live data feed. We sent a link to your address.');
	});

	it('never says quota, abuse or 402', () => {
		for (const code of ['email_unverified', 'email_disposable'] as const) {
			for (const f of ['assistant', 'feeds'] as const) expect(emailGateText(code, f, 'a@example.com')).not.toMatch(/quota|abuse|402/i);
		}
	});
});
