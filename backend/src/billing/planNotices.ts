// The owners' plan emails (issue #641 § Downgrade or lapse, "Reverse trial";
// docs/billing.md § Plan emails; 346_billing_notices.sql).
//
// Each tick of the worker (jobs/runner.ts), after the pause sweep (341):
//
//   1. Queue. app_billing_notice_queue inserts one row per account, kind,
//      occurrence and owner (the person, or each admin of the team):
//      'grace' when a paid plan has ended with the account past Free's live
//      catchments and the 14 days are still running, 'paused' once a catchment
//      of it is paused (both only with billing enforced), and 'trial_ending'
//      when a reverse trial ends within 3 days. Its primary key makes each once.
//   2. Send. Each claimed email is built in a read-only transaction *as its
//      recipient*, under RLS: the account is read again as they see it, and an
//      email whose occurrence is over (back on a plan, back within Free, the
//      trial ended or replaced, enforcement turned off) or whose account is no
//      longer theirs is skipped, as is one to an unconfirmed or suppressed
//      address. The catchments it names are only those the recipient can read
//      (app_plan_pause_preview gives no id for the rest, which are counted).
//      The outcome is recorded in the worker's own context; a transport error
//      is retried on the next tick (3 attempts), and a worker that dies
//      mid-send leaves it failed, never sent twice (329's pattern).
//
// Logs name the account and the kind only: never the address, the person or
// a catchment.
import { PLAN_ENDED_GRACE_DAYS } from '@water-management/engine/plans';
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { planNoticeMail, type PlanAccount } from '../mail/templates.js';
import { sendMail, type Mail } from '../mail/transport.js';

/** The grace after a paid plan ends before the pause (341's interval), from the plan figures (#941). */
export const PLAN_GRACE_DAYS = PLAN_ENDED_GRACE_DAYS;

const LEASE = '10 minutes';

export type PlanNoticeKind = 'grace' | 'paused' | 'trial_ending';

export interface PlanNoticeResult {
	queued: number;
	sent: number;
	skipped: number;
	failed: number;
}

interface Claimed {
	billing_account_id: string;
	kind: PlanNoticeKind;
	about: Date;
	/** `about` as Postgres wrote it, with its microseconds, so it finds its row again. */
	about_key: string;
	user_id: string;
}

type Prepared = { mail: Mail } | { skip: string };

/** One email, built as its recipient (the transaction's user), or why not. */
export async function preparePlanNotice(db: Db, c: Claimed): Promise<Prepared> {
	const { rows: me } = await db.query<{ email: string; locale: string | null; verified: boolean; suppressed: boolean }>(
		`SELECT email, locale, email_verified_at IS NOT NULL AS verified, mail_suppressed_at IS NOT NULL AS suppressed
		 FROM app_user WHERE id = app_current_user_id()`
	);
	const u = me[0];
	if (!u?.verified) return { skip: 'no confirmed address' };
	if (u.suppressed) return { skip: 'the address is suppressed (a bounce or complaint)' };

	if (c.kind === 'trial_ending') {
		// Under RLS: only the account's own person reads it (subscription_read, 323).
		const { rows } = await db.query<{ plan: string }>(
			`SELECT p.name AS plan FROM subscription s
			 JOIN billing_account a ON a.id = s.billing_account_id AND a.kind = 'user' AND a.user_id = app_current_user_id()
			 JOIN plan p ON p.code = s.plan_code
			 WHERE a.id = $1 AND s.provider = 'manual' AND s.status = 'trialing' AND s.trial_end = $2::timestamptz AND s.trial_end > now()`,
			[c.billing_account_id, c.about_key]
		);
		if (!rows[0]) return { skip: 'the trial ended, was replaced or is no longer theirs' };
		return { mail: planNoticeMail(u.email, { kind: 'trial_ending', plan: rows[0].plan, trialEnd: c.about }, u.locale) };
	}

	const { rows: enforced } = await db.query<{ on: boolean }>(`SELECT coalesce(current_setting('app.billing_enforced', true), '') = 'on' AS on`);
	if (!enforced[0]?.on) return { skip: 'billing is not enforced' };
	// Under RLS: the account's person, or an admin of its team (billing_account_read, 323).
	const { rows: accounts } = await db.query<{ current: boolean; team: string | null }>(
		`SELECT a.over_free_since IS NOT DISTINCT FROM $2::timestamptz AS current, t.name AS team
		 FROM billing_account a LEFT JOIN team t ON t.id = a.team_id
		 WHERE a.id = $1`,
		[c.billing_account_id, c.about_key]
	);
	const a = accounts[0];
	if (!a) return { skip: 'the account is no longer theirs' };
	if (!a.current) return { skip: 'back on a plan or within Free since it was queued' };
	// 341's order; a catchment they can't read has no id. Names under RLS (project_read).
	const { rows: live } = await db.query<{ keeps: boolean; paused: boolean; name: string | null }>(
		`SELECT v.keeps, v.paused, p.name FROM app_plan_pause_preview($1) WITH ORDINALITY AS v(project_id, keeps, paused, o)
		 LEFT JOIN project p ON p.id = v.project_id
		 ORDER BY v.o`,
		[c.billing_account_id]
	);
	const past = live.filter((r) => !r.keeps);
	if (!past.length) return { skip: 'back within Free since it was queued' };
	const anyPaused = live.some((r) => r.paused);
	if (c.kind === 'grace' && anyPaused) return { skip: 'already paused (the pause email says so)' };
	if (c.kind === 'paused' && !anyPaused) return { skip: 'nothing is paused any more' };
	const named = (rs: typeof live) => rs.flatMap((r) => (r.name === null ? [] : [r.name]));
	const account: PlanAccount = a.team === null ? { kind: 'personal' } : { kind: 'team', team: a.team };
	const pausesAt = new Date(c.about.getTime() + PLAN_GRACE_DAYS * 86_400_000);
	return {
		mail: planNoticeMail(
			u.email,
			{
				kind: c.kind,
				account,
				pausesAt,
				pausing: named(past),
				othersPausing: past.filter((r) => r.name === null).length,
				keeps: named(live.filter((r) => r.keeps))
			},
			u.locale
		)
	};
}

const finish = (c: Claimed, status: 'sent' | 'skipped' | 'retry', reason: string | null = null) =>
	withoutUser((db) =>
		db.query('SELECT app_billing_notice_finish($1, $2, $3::timestamptz, $4, $5, $6)', [c.billing_account_id, c.kind, c.about_key, c.user_id, status, reason])
	);

/** Never the raw error text (SES writes the address into it): its name and code only. */
const failureReason = (err: unknown) => `send failed (${safeError(err).error})`;

async function deliver(c: Claimed, r: PlanNoticeResult): Promise<void> {
	const ids = { accountId: c.billing_account_id, kind: c.kind };
	let p: Prepared;
	try {
		p = await withUser(c.user_id, (db) => preparePlanNotice(db, c), { readOnly: true });
	} catch (err) {
		logEvent('error', { event: 'plan_notice_prepare_failed', ...ids, ...safeError(err) });
		await finish(c, 'retry', failureReason(err));
		r.failed++;
		return;
	}
	if ('skip' in p) {
		logEvent('info', { event: 'plan_notice_skipped', ...ids, reason: p.skip });
		await finish(c, 'skipped', p.skip);
		r.skipped++;
		return;
	}
	try {
		await sendMail(p.mail);
	} catch (err) {
		// The line the mail-send-failed alarm counts (infra/alarms.tf): kind and error code only.
		logEvent('error', { event: 'mail_send_failed', kind: 'plan_notice', ...safeError(err) });
		await finish(c, 'retry', failureReason(err));
		r.failed++;
		return;
	}
	await finish(c, 'sent');
	logEvent('info', { event: 'plan_notice_sent', ...ids });
	r.sent++;
}

/** Queue what is due, then send every pending email. Every transport's tick ends here (jobs/runner.ts). */
export async function runPlanNotices({ limit = 100 }: { limit?: number } = {}): Promise<PlanNoticeResult> {
	const r: PlanNoticeResult = { queued: 0, sent: 0, skipped: 0, failed: 0 };
	try {
		r.queued = await withoutUser(async (db) => (await db.query<{ n: number }>('SELECT app_billing_notice_queue() AS n')).rows[0]?.n ?? 0);
	} catch (err) {
		// Never holds up the sends or the rest of the tick; the next tick queues what this one missed.
		logEvent('error', { event: 'plan_notice_queue_failed', ...safeError(err) });
	}
	const { rows } = await withoutUser((db) =>
		db.query<Claimed>(
			'SELECT billing_account_id, kind, about, about::text AS about_key, user_id FROM app_billing_notice_claim($1, $2::interval)',
			[limit, LEASE]
		)
	);
	for (const c of rows) await deliver(c, r);
	return r;
}
