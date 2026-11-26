// Changing the email address, re-verified (347_email_change.sql,
// auth/email-change-routes.ts), and the sign-up's disposable-domain refusal
// (auth/routes.ts /register, issue #641 item 5; a live invite for exactly the
// address is exempt). Mail is captured in memory.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGAL_VERSION } from '@water-management/engine/legal';
import { withUser } from '../db/tx.js';
import { SESSION_COOKIE } from './session.js';
import { anon, asOwner, lastMailTo, mailCount, signUp, tokenIn } from '../__tests__/helpers.js';

const PASSWORD = 'correct horse';
const fresh = (name: string) => `${name}-${crypto.randomUUID()}@example.com`;

afterEach(() => vi.unstubAllEnvs());

/** The session cookie a response set, as a Cookie header. */
function sessionOf(res: { headers: Headers }): string {
	const m = (res.headers.get('set-cookie') ?? '').match(new RegExp(`${SESSION_COOKIE}=([^;,]+)`));
	expect(m, 'a session cookie').not.toBeNull();
	return `${SESSION_COOKIE}=${m![1]}`;
}

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

	it('is allowed through a live invite for exactly that address (invitees are always free); not through one for another', async () => {
		const owner = await signUp('DisposableInviter');
		const projectId = (await owner.call('POST', '/projects', { name: 'Invites a throwaway' })).body.project.id as string;
		const invite = async (email: string) => {
			expect((await owner.call('POST', `/projects/${projectId}/members`, { email, role: 'viewer' })).status).toBe(201);
			return tokenIn(lastMailTo(email));
		};
		vi.stubEnv('BILLING_ENFORCED', 'true');
		const invited = `farmer-${crypto.randomUUID()}@mailinator.com`;
		const token = await invite(invited);
		const ok = await anon('POST', '/auth/register', {
			email: invited,
			password: PASSWORD,
			displayName: 'Farmer',
			acceptTerms: LEGAL_VERSION,
			inviteToken: token
		});
		expect(ok.status).toBe(201);
		expect(ok.body.user.email).toBe(invited);
		// Positive control: another disposable address carrying that (live) invite is still refused, and nothing is made.
		const other = `other-${crypto.randomUUID()}@mailinator.com`;
		const otherToken = await invite(`second-${crypto.randomUUID()}@mailinator.com`);
		const refused = await anon('POST', '/auth/register', {
			email: other,
			password: PASSWORD,
			displayName: 'Other',
			acceptTerms: LEGAL_VERSION,
			inviteToken: otherToken
		});
		expect(refused.status).toBe(400);
		expect(refused.body.code).toBe('signup_disposable');
		expect(await asOwner('SELECT 1 FROM app_user WHERE email = $1', [other])).toEqual([]);
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
		// Confirming signs the account's sessions out (this one was signed out: no cookie came back with it).
		expect((await u.call('GET', '/auth/me')).status).toBe(401);
		const signedIn = await login(next);
		expect(signedIn.status).toBe(200);
		const me = (await anon('GET', '/auth/me', undefined, sessionOf(signedIn))).body.user;
		expect(me.email).toBe(next);
		expect(me.emailVerified).toBe(true);
		expect((await login(u.email)).status).toBe(401);

		const notice = lastMailTo(u.email);
		expect(notice?.subject).toMatch(/Your email address was changed/);
		expect(notice!.text).toContain(next);

		// Single use.
		const again = await anon('POST', '/auth/confirm-email-change', { token });
		expect(again.status).toBe(400);
		expect(again.body.code).toBe('link_invalid');
	});

	it('signs out every other session; the browser that confirms, signed in to the account, stays signed in', async () => {
		const u = await signUp('Sessions');
		const elsewhere = sessionOf(await login(u.email));
		expect((await anon('GET', '/auth/me', undefined, elsewhere)).status).toBe(200);
		const next = fresh('sessions');
		await u.call('POST', '/auth/change-email', { newEmail: next, currentPassword: PASSWORD });
		const ok = await anon('POST', '/auth/confirm-email-change', { token: tokenIn(lastMailTo(next)) }, u.cookie);
		expect(ok.status).toBe(200);
		// Positive control: this browser, with its re-issued cookie, is still signed in (as the new address).
		const mine = sessionOf(ok);
		expect((await anon('GET', '/auth/me', undefined, mine)).body.user.email).toBe(next);
		// The other session, and this browser's old cookie, are signed out.
		expect((await anon('GET', '/auth/me', undefined, elsewhere)).status).toBe(401);
		expect((await u.call('GET', '/auth/me')).status).toBe(401);
	});

	it('confirmed signed out (or as someone else), every session of the account is signed out and none is issued', async () => {
		const u = await signUp('SessionsAnon');
		const bystander = await signUp('Bystander');
		const next = fresh('anon-sessions');
		await u.call('POST', '/auth/change-email', { newEmail: next, currentPassword: PASSWORD });
		const ok = await anon('POST', '/auth/confirm-email-change', { token: tokenIn(lastMailTo(next)) }, bystander.cookie);
		expect(ok.status).toBe(200);
		expect(ok.headers.get('set-cookie') ?? '').not.toContain(`${SESSION_COOKIE}=`);
		expect((await u.call('GET', '/auth/me')).status).toBe(401);
		// The bystander's own session is untouched.
		expect((await bystander.call('GET', '/auth/me')).status).toBe(200);
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

	it('answers a taken address the same as a free one, tells its holder instead (no link), and counts it under the same limits', async () => {
		const u = await signUp('Asker');
		const other = await signUp('Holder');
		const before = mailCount(other.email);
		const taken = await u.call('POST', '/auth/change-email', { newEmail: other.email, currentPassword: PASSWORD });
		expect(taken.status).toBe(202);
		expect(taken.body).toEqual({ sent: true, email: other.email });
		// The holder gets the email change's own "this address already has an account" (a password-reset
		// link), never sign-up's wording, never a change link, and nothing naming the asker.
		expect(mailCount(other.email)).toBe(before + 1);
		const told = lastMailTo(other.email)!;
		expect(told.kind).toBe('email_change_taken');
		expect(told.subject).toMatch(/This address already has an account/);
		expect(told.text).toMatch(/asked to change the email address of an IC-WBT account to/);
		expect(told.text).not.toMatch(/create an/);
		expect(told.text).toContain('http://localhost:7777/reset-password?token=');
		expect(told.text).not.toContain('/verify-email/change');
		expect(told.text).not.toContain(u.email);
		expect(told.html).not.toContain(u.email);
		expect((await other.call('GET', '/auth/me')).body.user.email).toBe(other.email);
		// The cooldown holds after a taken address exactly as after a free one, so a 429 tells nothing.
		const next = await u.call('POST', '/auth/change-email', { newEmail: fresh('after'), currentPassword: PASSWORD });
		expect(next.status).toBe(429);
		expect(next.body.code).toBe('verification_sent_recently');
	});

	it('a taken but never-confirmed address: its holder gets a confirmation link in the same email, and the reset link never', async () => {
		const u = await signUp('AskerOfPending');
		const pending = await signUp('PendingHolder', { verified: false });
		// Past the sign-up's own confirmation cooldown, so the holder's link can go out.
		await asOwner("UPDATE email_token SET created_at = created_at - interval '2 hours' WHERE user_id = (SELECT id FROM app_user WHERE email = $1)", [pending.email]);
		const before = mailCount(pending.email);
		const res = await u.call('POST', '/auth/change-email', { newEmail: pending.email, currentPassword: PASSWORD });
		expect([res.status, res.body]).toEqual([202, { sent: true, email: pending.email }]);
		expect(mailCount(pending.email)).toBe(before + 1);
		const told = lastMailTo(pending.email)!;
		expect(told.kind).toBe('email_change_taken');
		expect(told.text).toMatch(/isn’t confirmed yet/);
		expect(told.text).toMatch(/http:\/\/localhost:7777\/verify-email\?token=/);
		expect(told.text).not.toContain('/reset-password');
		expect(told.text).not.toContain(u.email);
		// The link confirms the holder's own account (positive control: it's a real verify token).
		const confirmed = await anon('POST', '/auth/verify-email', { token: tokenIn(told)! });
		expect(confirmed.status).toBe(200);
	});

	it('the holder’s mail keeps to the holder’s own cooldown: a second try straight after mails nothing more', async () => {
		const a = await signUp('TryOne');
		const b = await signUp('TryTwo');
		const holder = await signUp('Held');
		expect((await a.call('POST', '/auth/change-email', { newEmail: holder.email, currentPassword: PASSWORD })).status).toBe(202);
		const after = mailCount(holder.email);
		expect((await b.call('POST', '/auth/change-email', { newEmail: holder.email, currentPassword: PASSWORD })).status).toBe(202);
		expect(mailCount(holder.email)).toBe(after);
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
		// Confirming signed out signs every session out: the new address signs in.
		expect((await anon('GET', '/auth/me', undefined, sessionOf(await login(second)))).body.user.email).toBe(second);
	});

	// A link someone else asked for with a stolen session and password (to their own inbox) must not outlive the
	// owner securing the account: otherwise it moves the address to them after the owner changed the password.
	describe('a pending change dies when the owner secures the account', () => {
		async function pending(name: string) {
			const u = await signUp(name);
			const next = fresh(name.toLowerCase());
			expect((await u.call('POST', '/auth/change-email', { newEmail: next, currentPassword: PASSWORD })).status).toBe(202);
			return { u, next, token: tokenIn(lastMailTo(next)) };
		}
		const refused = async (u: { id: string; email: string }, token: string) => {
			const res = await anon('POST', '/auth/confirm-email-change', { token });
			expect(res.status).toBe(400);
			expect(res.body.code).toBe('link_invalid');
			expect((await asOwner('SELECT email FROM app_user WHERE id = $1', [u.id]))[0]!.email).toBe(u.email);
		};

		it('changing the password voids it', async () => {
			const { u, token } = await pending('Changed');
			expect((await u.call('POST', '/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another horse' })).status).toBe(200);
			await refused(u, token);
		});

		it('a password reset voids it', async () => {
			const { u, token } = await pending('Reset');
			expect((await anon('POST', '/auth/forgot-password', { email: u.email })).status).toBe(202);
			const reset = tokenIn(lastMailTo(u.email));
			expect((await anon('POST', '/auth/reset-password', { token: reset, password: 'another horse' })).status).toBe(204);
			await refused(u, token);
		});

		it('signing out everywhere voids it', async () => {
			const { u, token } = await pending('Everywhere');
			expect((await u.call('POST', '/auth/logout-everywhere')).status).toBe(204);
			await refused(u, token);
		});

		it('positive control: an unrelated action (renaming) leaves the link working', async () => {
			const { u, next, token } = await pending('Kept');
			expect((await u.call('PATCH', '/auth/me', { displayName: 'Kept Too' })).status).toBe(200);
			expect((await anon('POST', '/auth/confirm-email-change', { token })).body).toEqual({ changed: true, email: next });
		});
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
