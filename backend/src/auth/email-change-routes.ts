// Changing the account's email address, re-verified (issue #641 item 5;
// 347_email_change.sql; docs/security.md § Changing the email address).
//
// POST /auth/change-email (signed in, with the current password, checked
// through the sign-in lockout as change-password is) mails a link to the NEW
// address; the account's address switches only when POST
// /auth/confirm-email-change uses that link, and the OLD address then gets a
// notice. Mounted under /auth beside routes.ts.
import { Hono } from 'hono';
import { z } from 'zod';
import { actAsUser, withoutUser, withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { readJson } from '../http/body.js';
import { emailChangeMail, emailChangedMail, siteLink } from '../mail/templates.js';
import { trySendMail, type Mail } from '../mail/transport.js';
import { billingEnforced } from '../billing/enforced.js';
import { answerAlike } from './accountMail.js';
import { isDisposable } from './disposable.js';
import { markVerified } from './email-routes.js';
import { logLoginFailed } from './loginFailed.js';
import { requireUser, type AuthEnv } from './middleware.js';
import { checkPasswordAgain, takenAddressMail } from './routes.js';
import { issueDevice } from './device.js';
import { issueSession, readSessionClaims } from './session.js';
import { requireCodeIfEnrolled } from './stepUp.js';
import { ACCOUNT_MAIL_CAP, ACCOUNT_MAIL_WINDOW, newToken, parseToken, RESEND_COOLDOWN, TOKEN_TTL } from './tokens.js';

const ChangeEmailBody = z.object({
	newEmail: z.string().trim().toLowerCase().email().max(254),
	currentPassword: z.string().min(1).max(200)
});
const ConfirmBody = z.object({ token: z.string().max(200) });

/** A unique violation (app_user's email, taken between the request and the link). */
const isUniqueViolation = (err: unknown): boolean => (err as { code?: string }).code === '23505';

export const emailChangeRoutes = new Hono<AuthEnv>()
	// 202 { sent, email } whether or not the new address already has an account:
	// a taken address gets no link (app_user's email is unique) and nothing is
	// said, after the same time (answerAlike) and under the same limits (the
	// link is issued before the address is looked up), so this can't find
	// accounts any better than sign-up can. As at sign-up, the taken address's
	// holder is told instead (takenAddressMail: its own email, "someone asked to
	// change an account's address to this one", never naming that account, with
	// a reset or confirmation link), under that address's own cooldown and cap. Refused outright, before anything is looked up:
	// the account's own address (email_change_same) and, with BILLING_ENFORCED
	// on, a disposable domain (email_change_disposable; auth/disposable.ts, the
	// same rule as sign-up's). The link's cooldown and the daily cap are the
	// verification email's (tokens.ts, 078), counted on the account.
	.post('/change-email', requireUser, async (c) => {
		const body = ChangeEmailBody.parse(await readJson(c));
		const userId = c.get('userId');
		// With a second factor on, only a session that gave a code may move the address (stepUp.ts requireCodeIfEnrolled).
		await withUser(userId, (db) => requireCodeIfEnrolled(db, userId, c.get('amr') ?? [], 'to change your email address'));
		const account = await checkPasswordAgain(c, '/auth/change-email', body.currentPassword);
		if (account.email.toLowerCase() === body.newEmail) {
			throw ApiError.coded(400, 'email_change_same', 'that is already your email address');
		}
		if (billingEnforced() && isDisposable(body.newEmail)) {
			throw ApiError.coded(400, 'email_change_disposable', 'use a permanent email address: this one is from a temporary-mail service');
		}
		let refused: 'cooldown' | 'capped' | null = null;
		await answerAlike(async () => {
			const linkOrTaken = await withUser(userId, async (db): Promise<Mail | 'taken' | null> => {
				// Issued (and the cooldown and cap counted) before the address is looked up, so a taken
				// address and a free one meet the same limits: otherwise which one answers 429 would tell.
				const { token, hash } = newToken();
				const { rows: issued } = await db.query<{ status: 'issued' | 'cooldown' | 'capped' }>(
					'SELECT app_issue_email_change($1, $2, $3::interval, $4::interval, $5, $6::interval) AS status',
					[body.newEmail, hash, TOKEN_TTL.verify, RESEND_COOLDOWN.verify, ACCOUNT_MAIL_CAP, ACCOUNT_MAIL_WINDOW]
				);
				const status = issued[0]!.status;
				if (status !== 'issued') {
					refused = status;
					return null;
				}
				// The one-address lookup (068), signed in: a taken address gets no link (its pending row is
				// unusable: nobody has the token, and app_user's unique email would refuse it anyway).
				const { rows } = await db.query<{ id: string }>('SELECT id FROM app_auth_account($1)', [body.newEmail]);
				if (rows[0]) return 'taken';
				return emailChangeMail(body.newEmail, siteLink('/verify-email/change', token), account.locale);
			});
			if (linkOrTaken !== 'taken') return linkOrTaken;
			// The holder's mail, in its own transaction once the requester's has ended (one pooled connection at a
			// time), as no user until the lookup names the holder. Inside answerAlike, so it costs no visible time.
			return withoutUser((db) => takenAddressMail(db, body.newEmail, 'email-change'));
		});
		// The limits are the account's own, not the new address's, so saying so reveals nothing about it.
		if (refused === 'capped')
			throw ApiError.coded(429, 'verification_limit', 'too many confirmation emails were sent today — check your inbox, or try again tomorrow');
		if (refused === 'cooldown')
			throw ApiError.coded(429, 'verification_sent_recently', 'a confirmation email was sent a moment ago — check your inbox, or try again in a minute');
		return c.json({ sent: true as const, email: body.newEmail }, 202);
	})
	// The link from the new address's email. Works signed in or out (the token
	// is the proof that the new inbox is the requester's). Switches the address,
	// marks it verified (the first verification of an unconfirmed account does
	// what confirming does: invites, the reverse trial; markVerified), clears a
	// bounce suppression that was the old address's, and mails the old address.
	// Every session of the account is signed out, as a password change does
	// (sessions_revoked_at): a session someone kept on the old address goes with
	// it. The browser that confirms keeps its own if it is signed in to this
	// account (a fresh cookie, issued after the watermark, signed in the way it was).
	.post('/confirm-email-change', async (c) => {
		const body = ConfirmBody.parse(await readJson(c));
		const hash = parseToken(body.token);
		const invalid = () => {
			logLoginFailed('/auth/confirm-email-change', 'invalid_link');
			return ApiError.coded(400, 'link_invalid', 'this link is invalid or has expired — request a new one');
		};
		if (!hash) throw invalid();
		// Read before the watermark moves: whether this browser is signed in to the account the link changes.
		const current = await readSessionClaims(c);
		// From this server's clock, the one that stamps session iat_ms.
		const watermark = new Date();
		let outcome: { userId: string; email: string; old: string; locale: string | null } | null;
		try {
			outcome = await withoutUser(async (db) => {
				const { rows } = await db.query<{ user_id: string; new_email: string }>('SELECT * FROM app_consume_email_change($1)', [hash]);
				const change = rows[0];
				if (!change) return null;
				await actAsUser(db, change.user_id);
				const { rows: before } = await db.query<{ email: string; locale: string | null; verified: boolean }>(
					'SELECT email, locale, email_verified_at IS NOT NULL AS verified FROM app_user WHERE id = $1',
					[change.user_id]
				);
				if (!before[0]) return null;
				// Under app_user's own-row policy (068); its unique email refuses an address taken since.
				await db.query(
					`UPDATE app_user SET email = $2, mail_suppressed_at = NULL, mail_suppressed_reason = NULL,
					   email_verified_at = CASE WHEN email_verified_at IS NULL THEN NULL ELSE now() END,
					   sessions_revoked_at = $3
					 WHERE id = $1`,
					[change.user_id, change.new_email, watermark]
				);
				// Links mailed to the old address die with it.
				await db.query('DELETE FROM email_token WHERE user_id = $1', [change.user_id]);
				// So does an unconfirmed second-factor reset's confirmation link (414): whoever kept the old inbox can't start
				// the factor's removal. A confirmed reset keeps waiting; its emails go to the current address.
				await db.query('SELECT app_mfa_reset_end_unconfirmed()');
				if (!before[0].verified) await markVerified(db, change.user_id);
				return { userId: change.user_id, email: change.new_email, old: before[0].email, locale: before[0].locale };
			});
		} catch (err) {
			// The link's holder has the new inbox, so telling them it now has an account reveals nothing.
			if (isUniqueViolation(err)) throw ApiError.coded(409, 'email_change_taken', 'an account with that email address already exists');
			throw err;
		}
		if (!outcome) throw invalid();
		await trySendMail(emailChangedMail(outcome.old, outcome.email, outcome.locale));
		// This browser's own session, if it is this account's (not a render session), stays signed in, as change-password's does.
		if (current && !current.scope && current.userId.toLowerCase() === outcome.userId.toLowerCase()) {
			await issueSession(c, outcome.userId, undefined, current.amr);
		}
		// The link proved the new inbox: this browser signs in on its own lockout record for it (auth/device.ts).
		issueDevice(c, outcome.email, watermark);
		return c.json({ changed: true as const, email: outcome.email });
	});
