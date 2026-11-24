// The annual renewal notice (issue #641 § Billing provider; CPA s14(2)(c);
// docs/billing.md § Renewal notice; 329_renewal_notice.sql).
//
// Each tick of the worker (jobs/runner.ts), after the jobs:
//
//   1. Queue. Today's date in South Africa gives the range of end dates that
//      are due: those with RENEWAL_LATEST_BUSINESS_DAYS (45) to
//      RENEWAL_NOTICE_BUSINESS_DAYS (60) business days strictly between today
//      and the end (businessDays.ts, with the public holidays).
//      app_renewal_notice_queue inserts one row per subscription and period
//      whose end falls in it: a person's account, a yearly period, live and
//      not already cancelling. So the notice goes on the first tick 60
//      business days out, and a tick missed for any reason (an outage, a
//      subscription recorded late) still sends one up to 45 business days
//      out. 45, not 40, leaves room for up to five holidays declared after
//      this code was written (an election day), which the count can't know.
//      Its primary key makes it once per period: two ticks at once queue one.
//   2. Send. Each claimed notice is built in a transaction *as its
//      recipient* (withUser, read only), under RLS: the subscription is read
//      again as they see it, and a notice whose subscription was cancelled,
//      moved to another period, or no longer theirs is skipped, as is one to an
//      unconfirmed or suppressed address. The outcome is recorded in the
//      worker's own context (app_renewal_notice_finish); a transport error is
//      retried on the next tick (3 attempts), and a worker that dies mid-send
//      leaves it failed, never sent twice (133's pattern).
//
// Logs name the subscription only: never the address, the plan's price or
// the person (pseudonymous, like the alert mails' lines).
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { renewalNoticeMail } from '../mail/templates.js';
import { sendMail, type Mail } from '../mail/transport.js';
import { endDatesWithin, saDate } from './businessDays.js';

/** The notice goes when this many business days are left before the period ends (#641; inside CPA s14's 40–80). */
export const RENEWAL_NOTICE_BUSINESS_DAYS = 60;
/** A notice not sent by then still goes down to this many (CPA's floor is 40; 5 kept for holidays declared later). */
export const RENEWAL_LATEST_BUSINESS_DAYS = 45;

const LEASE = '10 minutes';

export interface RenewalNoticeResult {
	queued: number;
	sent: number;
	skipped: number;
	failed: number;
}

interface Claimed {
	subscription_id: string;
	period_end: Date;
	/** period_end as Postgres wrote it, with its microseconds (a JS Date keeps milliseconds), so it finds its row again. */
	period_key: string;
	user_id: string;
}

type Prepared = { mail: Mail } | { skip: string };

/** Queue the notices due today (see the header). Returns how many new ones. */
export async function queueRenewalNotices(now: Date = new Date()): Promise<number> {
	const range = endDatesWithin(saDate(now), RENEWAL_LATEST_BUSINESS_DAYS, RENEWAL_NOTICE_BUSINESS_DAYS);
	if (!range) return 0;
	const { rows } = await withoutUser((db) => db.query<{ n: number }>('SELECT app_renewal_notice_queue($1::date, $2::date) AS n', [range.from, range.to]));
	return rows[0]?.n ?? 0;
}

/** One notice's mail, built as its recipient (the transaction's user), or why not. */
export async function prepareRenewalNotice(db: Db, c: Claimed): Promise<Prepared> {
	const { rows: me } = await db.query<{ email: string; locale: string | null; verified: boolean; suppressed: boolean }>(
		`SELECT email, locale, email_verified_at IS NOT NULL AS verified, mail_suppressed_at IS NOT NULL AS suppressed
		 FROM app_user WHERE id = app_current_user_id()`
	);
	const u = me[0];
	if (!u?.verified) return { skip: 'no confirmed address' };
	if (u.suppressed) return { skip: 'the address is suppressed (a bounce or complaint)' };
	// Under RLS: only the account's own person reads it (subscription_read, 323).
	const { rows: subs } = await db.query<{ plan: string; amount: number; currency: string; current: boolean }>(
		`SELECT p.name AS plan, p.price_annual_minor AS amount, p.currency,
			(s.status IN ('active', 'past_due') AND NOT s.cancel_at_period_end AND s.period_end = $2::timestamptz) AS current
		 FROM subscription s
		 JOIN billing_account a ON a.id = s.billing_account_id AND a.kind = 'user' AND a.user_id = app_current_user_id()
		 JOIN plan p ON p.code = s.plan_code
		 WHERE s.id = $1`,
		[c.subscription_id, c.period_key]
	);
	const s = subs[0];
	if (!s) return { skip: 'the subscription is no longer theirs' };
	if (!s.current) return { skip: 'cancelled, ended or moved to another period since it was queued' };
	return { mail: renewalNoticeMail(u.email, { plan: s.plan, periodEnd: c.period_end, amountMinor: s.amount, currency: s.currency }, u.locale) };
}

const finish = (c: Claimed, status: 'sent' | 'skipped' | 'retry', reason: string | null = null) =>
	withoutUser((db) => db.query('SELECT app_renewal_notice_finish($1, $2::timestamptz, $3, $4)', [c.subscription_id, c.period_key, status, reason]));

/** Never the raw error text (SES writes the address into it): its name and code only. */
const failureReason = (err: unknown) => `send failed (${safeError(err).error})`;

async function deliver(c: Claimed, r: RenewalNoticeResult): Promise<void> {
	let p: Prepared;
	try {
		p = await withUser(c.user_id, (db) => prepareRenewalNotice(db, c), { readOnly: true });
	} catch (err) {
		logEvent('error', { event: 'renewal_notice_prepare_failed', subscriptionId: c.subscription_id, ...safeError(err) });
		await finish(c, 'retry', failureReason(err));
		r.failed++;
		return;
	}
	if ('skip' in p) {
		logEvent('info', { event: 'renewal_notice_skipped', subscriptionId: c.subscription_id, reason: p.skip });
		await finish(c, 'skipped', p.skip);
		r.skipped++;
		return;
	}
	try {
		await sendMail(p.mail);
	} catch (err) {
		// The line the mail-send-failed alarm counts (infra/alarms.tf): kind and error code only.
		logEvent('error', { event: 'mail_send_failed', kind: 'renewal_notice', ...safeError(err) });
		await finish(c, 'retry', failureReason(err));
		r.failed++;
		return;
	}
	await finish(c, 'sent');
	logEvent('info', { event: 'renewal_notice_sent', subscriptionId: c.subscription_id });
	r.sent++;
}

/** Queue what is due today, then send every pending notice. Every transport's tick ends here (jobs/runner.ts). */
export async function runRenewalNotices({ now = new Date(), limit = 100 }: { now?: Date; limit?: number } = {}): Promise<RenewalNoticeResult> {
	const r: RenewalNoticeResult = { queued: 0, sent: 0, skipped: 0, failed: 0 };
	try {
		r.queued = await queueRenewalNotices(now);
	} catch (err) {
		// Never holds up the sends or the rest of the tick; the next tick queues what this one missed.
		logEvent('error', { event: 'renewal_notice_queue_failed', ...safeError(err) });
	}
	const { rows } = await withoutUser((db) =>
		db.query<Claimed>('SELECT subscription_id, period_end, period_end::text AS period_key, user_id FROM app_renewal_notice_claim($1, $2::interval)', [limit, LEASE])
	);
	for (const c of rows) await deliver(c, r);
	return r;
}
