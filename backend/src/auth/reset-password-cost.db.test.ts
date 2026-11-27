// POST /auth/reset-password hashes the new password only for a live link
// (auth/email-routes.ts; docs/security.md § Password reset and email
// verification). The hash is Argon2id at 64 MiB, the costliest thing a
// signed-out caller can ask for, so a made-up or spent token must not buy one.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anon, asOwner, lastMailTo, signUp, tokenIn } from '../__tests__/helpers.js';
import { hashPassword } from './password.js';

vi.mock('./password.js', async () => {
	const actual = await vi.importActual<typeof import('./password.js')>('./password.js');
	return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});

const hashes = vi.mocked(hashPassword);

describe('reset-password hashes only for a live link', () => {
	beforeEach(() => {
		hashes.mockClear();
	});

	it('a well-formed token nobody issued is refused without a hash', async () => {
		const res = await anon('POST', '/auth/reset-password', { token: 'A'.repeat(43), password: 'brand new password' });
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('link_invalid');
		expect(hashes).not.toHaveBeenCalled();
	});

	it('a spent or expired link is refused without a hash; the live one is the positive control', async () => {
		const u = await signUp('ResetCost');
		await anon('POST', '/auth/forgot-password', { email: u.email });
		const token = tokenIn(lastMailTo(u.email));

		// Positive control: the live link hashes once and resets (the sign-up's own hash isn't counted).
		hashes.mockClear();
		expect((await anon('POST', '/auth/reset-password', { token, password: 'brand new password' })).status).toBe(204);
		expect(hashes).toHaveBeenCalledTimes(1);
		hashes.mockClear();

		// Spent.
		expect((await anon('POST', '/auth/reset-password', { token, password: 'another password' })).status).toBe(400);
		expect(hashes).not.toHaveBeenCalled();

		// Expired (a new link, past its time).
		// The cooldown reads the token table: clear it so a second link goes out.
		await asOwner(`DELETE FROM email_token WHERE user_id = $1`, [u.id]);
		await anon('POST', '/auth/forgot-password', { email: u.email });
		const late = tokenIn(lastMailTo(u.email));
		expect(late).not.toBe(token);
		await asOwner(`UPDATE email_token SET expires_at = now() - interval '1 second' WHERE user_id = $1 AND purpose = 'reset'`, [u.id]);
		expect((await anon('POST', '/auth/reset-password', { token: late, password: 'another password' })).status).toBe(400);
		expect(hashes).not.toHaveBeenCalled();
		// The password from the live link still stands.
		expect((await anon('POST', '/auth/login', { email: u.email, password: 'brand new password' })).status).toBe(200);
	});
});
