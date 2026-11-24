// Changing the email address, re-verified (347_email_change.sql,
// auth/email-change-routes.ts), and the sign-up's disposable-domain refusal
// (auth/routes.ts /register, issue #641 item 5). Mail is captured in memory.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGAL_VERSION } from '@water-management/engine/legal';
import { withUser } from '../db/tx.js';
import { anon, asOwner, lastMailTo, mailCount, signUp, tokenIn } from '../__tests__/helpers.js';

const PASSWORD = 'correct horse';
const fresh = (name: string) => `${name}-${crypto.randomUUID()}@example.com`;

afterEach(() => vi.unstubAllEnvs());

async function login(email: string, password = PASSWORD) {
	return anon('POST', '/auth/login', { email, password });
}

describe('sign-up with a disposable address', () => {
	const register = (email: string) =>
		anon('POST', '/auth/register', { email, password: PASSWORD, displayName: 'Temp', acceptTerms: LEGAL_VERSION });

	it('is refused with signup_disposable while billing is enforced, and nothing is made or mailed', async () => {
		vi.stubEnv('BILLING_ENFORCED', 'true');
		const email = `temp-${crypto.randomUUID()}@mailinator.com`;
		const res = await register(email);
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('signup_disposable');
		expect(mailCount(email)).toBe(0);
		expect(await asOwner('SELECT 1 FROM app_user WHERE email = $1', [email])).toEqual([]);
	});

	it('positive controls: a permanent address signs up with billing enforced, and a disposable one with it off', async () => {
		vi.stubEnv('BILLING_ENFORCED', 'true');
		expect((await register(fresh('permanent'))).status).toBe(202);
		vi.stubEnv('BILLING_ENFORCED', 'false');
		expect((await register(`temp-${crypto.randomUUID()}@mailinator.com`)).status).toBe(202);
	});
});

describe('changing the email address', () => {
	it('mails a link to the new address and switches only when it is used; the old address gets a notice', async () => {
		const u = await signUp('Mover');
		const next = fresh('moved');
		const res = await u.call('POST', '/auth/change-email', { newEmail: next.toUpperCase(), currentPassword: PASSWORD });
		expect(res.status).toBe(202);
		expect(res.body).toEqual({ sent: true, email: next });
		const mail = lastMailTo(next);
		expect(mail?.subject).toMatch(/Confirm your new email address/);
		const token = tokenIn(mail);
		expect(mail!.text).toContain(`http://localhost:7777/verify-email/change?token=${token}`);

		// Nothing changed yet: the old address still signs in, the new one doesn't.
		expect((await u.call('GET', '/auth/me')).body.user.email).toBe(u.email);
		expect((await login(next)).status).toBe(401);

		// Anonymous on purpose: the token is the credential (opened on another device).
		const ok = await anon('POST', '/auth/confirm-email-change', { token });
		expect(ok.status).toBe(200);
		expect(ok.body).toEqual({ changed: true, email: next });
		const me = (await u.call('GET', '/auth/me')).body.user;
		expect(me.email).toBe(next);
		expect(me.emailVerified).toBe(true);
		expect((await login(next)).status).toBe(200);
		expect((await login(u.email)).status).toBe(401);

		const notice = lastMailTo(u.email);
		expect(notice?.subject).toMatch(/Your email address was changed/);
		expect(notice!.text).toContain(next);

		// Single use.
		const again = await anon('POST', '/auth/confirm-email-change', { token });
		expect(again.status).toBe(400);
		expect(again.body.code).toBe('link_invalid');
	});

	it('refuses an expired link and leaves the address as it was', async () => {
		const u = await signUp('Expire');
		const next = fresh('late');
		await u.call('POST', '/auth/change-email', { newEmail: next, currentPassword: PASSWORD });
		const token = tokenIn(lastMailTo(next));
		await asOwner(`UPDATE email_change SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.id]);
		const res = await anon('POST', '/auth/confirm-email-change', { token });
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('link_invalid');
		expect((await u.call('GET', '/auth/me')).body.user.email).toBe(u.email);
		expect((await anon('POST', '/auth/confirm-email-change', { token: 'A'.repeat(43) })).status).toBe(400);
		expect((await anon('POST', '/auth/confirm-email-change', { token: 'nope' })).status).toBe(400);
	});

	it('a change link is no verify or reset token, and theirs are not change links', async () => {
		const u = await signUp('Purpose');
		const next = fresh('purpose');
		await u.call('POST', '/auth/change-email', { newEmail: next, currentPassword: PASSWORD });
		const token = tokenIn(lastMailTo(next));
		expect((await anon('POST', '/auth/verify-email', { token })).status).toBe(400);
		expect((await anon('POST', '/auth/reset-password', { token, password: 'new password 1' })).status).toBe(400);
		// …and it wasn't burned by the attempts.
		expect((await anon('POST', '/auth/confirm-email-change', { token })).status).toBe(200);
	});

	it('needs the current password, through the sign-in lockout', async () => {
		const u = await signUp('Guard');
		const next = fresh('guard');
		const res = await u.call('POST', '/auth/change-email', { newEmail: next, currentPassword: 'wrong password' });
		expect(res.status).toBe(403);
		expect(res.body.code).toBe('wrong_current_password');
		expect(mailCount(next)).toBe(0);
		expect((await anon('POST', '/auth/change-email', { newEmail: next, currentPassword: PASSWORD })).status).toBe(401);
	});

	it('refuses the same address, and a disposable one while billing is enforced (positive control: off, it goes)', async () => {
		const u = await signUp('Same');
		const same = await u.call('POST', '/auth/change-email', { newEmail: u.email, currentPassword: PASSWORD });
		expect(same.status).toBe(400);
		expect(same.body.code).toBe('email_change_same');

		vi.stubEnv('BILLING_ENFORCED', 'true');
		const temp = `temp-${crypto.randomUUID()}@mailinator.com`;
		const refused = await u.call('POST', '/auth/change-email', { newEmail: temp, currentPassword: PASSWORD });
		expect(refused.status).toBe(400);
		expect(refused.body.code).toBe('email_change_disposable');
		expect(mailCount(temp)).toBe(0);

		vi.stubEnv('BILLING_ENFORCED', 'false');
		expect((await u.call('POST', '/auth/change-email', { newEmail: temp, currentPassword: PASSWORD })).status).toBe(202);
		expect(mailCount(temp)).toBe(1);
	});

	it('answers a taken address the same as a free one, sends it nothing, and counts it under the same limits', async () => {
		const u = await signUp('Asker');
		const other = await signUp('Holder');
		const before = mailCount(other.email);
		const taken = await u.call('POST', '/auth/change-email', { newEmail: other.email, currentPassword: PASSWORD });
		expect(taken.status).toBe(202);
		expect(taken.body).toEqual({ sent: true, email: other.email });
		expect(mailCount(other.email)).toBe(before);
		expect((await other.call('GET', '/auth/me')).body.user.email).toBe(other.email);
		// The cooldown holds after a taken address exactly as after a free one, so a 429 tells nothing.
		const next = await u.call('POST', '/auth/change-email', { newEmail: fresh('after'), currentPassword: PASSWORD });
		expect(next.status).toBe(429);
		expect(next.body.code).toBe('verification_sent_recently');
	});

	it('refuses the switch if the address was taken after the link went out', async () => {
		const u = await signUp('Racer');
		const next = fresh('race');
		await u.call('POST', '/auth/change-email', { newEmail: next, currentPassword: PASSWORD });
		const token = tokenIn(lastMailTo(next));
		// Someone signs up with it in between (unverified is enough: the address is taken).
		expect((await anon('POST', '/auth/register', { email: next, password: PASSWORD, displayName: 'Other', acceptTerms: LEGAL_VERSION })).status).toBe(202);
		const res = await anon('POST', '/auth/confirm-email-change', { token });
		expect(res.status).toBe(409);
		expect(res.body.code).toBe('email_change_taken');
		expect((await u.call('GET', '/auth/me')).body.user.email).toBe(u.email);
	});

	it('only the newest link works, and the cooldown holds between requests', async () => {
		const u = await signUp('Twice');
		const first = fresh('first');
		await u.call('POST', '/auth/change-email', { newEmail: first, currentPassword: PASSWORD });
		const firstToken = tokenIn(lastMailTo(first));
		expect((await u.call('POST', '/auth/change-email', { newEmail: fresh('soon'), currentPassword: PASSWORD })).status).toBe(429);
		await asOwner(`UPDATE email_change SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [u.id]);
		const second = fresh('second');
		expect((await u.call('POST', '/auth/change-email', { newEmail: second, currentPassword: PASSWORD })).status).toBe(202);
		expect((await anon('POST', '/auth/confirm-email-change', { token: firstToken })).status).toBe(400);
		expect((await anon('POST', '/auth/confirm-email-change', { token: tokenIn(lastMailTo(second)) })).status).toBe(200);
		expect((await u.call('GET', '/auth/me')).body.user.email).toBe(second);
	});

	it('RLS: a person sees only their own pending change (positive control: their own row)', async () => {
		const u = await signUp('Own');
		const other = await signUp('Peer');
		await u.call('POST', '/auth/change-email', { newEmail: fresh('own'), currentPassword: PASSWORD });
		const count = (as: string) =>
			withUser(as, async (db) => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM email_change WHERE user_id = $1', [u.id])).rows[0]!.n);
		expect(await count(u.id)).toBe(1);
		expect(await count(other.id)).toBe(0);
	});
});
