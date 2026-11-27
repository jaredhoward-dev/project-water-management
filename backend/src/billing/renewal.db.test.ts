// The annual renewal notice against Postgres (329_renewal_notice,
// billing/renewal.ts; docs/billing.md § Renewal notice). Who gets one, that a
// period gets one even from two ticks at once, that a missed day still sends,
// and what the email says. Subscriptions are planted as the schema owner (the
// webhook that writes them is tested in webhook.db.test.ts). Runs under the
// workspace's skewed TZ (CLAUDE.md rule 7): the dates are South Africa's.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, lastMailTo, mailCount, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { resetWhen } from '../mail/templates.js';
import { addDays, businessDaysBetween, endDatesWithin, saDate } from './businessDays.js';
import { RENEWAL_LATEST_BUSINESS_DAYS, RENEWAL_NOTICE_BUSINESS_DAYS, runRenewalNotices } from './renewal.js';

type Person = Awaited<ReturnType<typeof signUp>> & { email: string };

const today = () => saDate(new Date());
/** The first end date with exactly `n` business days before it, from today. */
const endWith = (n: number) => endDatesWithin(today(), n, n)!.from;
/** 10:00 SAST on a South African date. */
const at = (date: string) => `${date}T10:00:00+02:00`;

async function accountOf(p: Person): Promise<string> {
	return (await p.call('GET', '/account/plan')).body.account.id as string;
}

/** A subscription planted as the owner: a year (or a month) ending on `end`. */
async function plant(account: string, end: string, o: { months?: number; status?: string; plan?: string; cancelling?: boolean } = {}): Promise<string> {
	const months = o.months ?? 12;
	const [s] = await asOwner(
		`INSERT INTO subscription (billing_account_id, plan_code, status, seats, period_start, period_end, cancel_at_period_end, provider, external_ref)
		 VALUES ($1, $2, $3, 1, $4::timestamptz - make_interval(months => $5), $4::timestamptz, $6, 'manual', $7) RETURNING id`,
		[account, o.plan ?? 'pro', o.status ?? 'active', at(end), months, o.cancelling ?? false, `renewal-${crypto.randomUUID()}`]
	);
	return s.id as string;
}

const notices = async (subscription: string) =>
	(await asOwner('SELECT status, reason, attempts FROM renewal_notice WHERE subscription_id = $1', [subscription])) as { status: string; reason: string | null; attempts: number }[];

/** Ends a planted subscription, so the next test's tick doesn't send its notice again (it can't: once per period) or count it. */
const retire = (id: string) => asOwner(`UPDATE subscription SET status = 'canceled' WHERE id = $1`, [id]);

async function person(name: string): Promise<Person> {
	const p = await signUp(name);
	const [u] = await asOwner('SELECT email FROM app_user WHERE id = $1', [p.id]);
	return Object.assign(p, { email: u.email as string });
}

beforeAll(() => {
	// The window the tests lean on is CPA s14's, with #641's 60 inside it.
	expect(RENEWAL_NOTICE_BUSINESS_DAYS).toBe(60);
	expect(RENEWAL_LATEST_BUSINESS_DAYS).toBeGreaterThanOrEqual(40);
});

describe('runRenewalNotices', () => {
	it('sends one notice to a person on a yearly plan 60 business days before it ends, naming the plan, the date and the price (positive control)', async () => {
		const p = await person('Renewer');
		const end = endWith(60);
		expect(businessDaysBetween(today(), end)).toBe(60);
		const sub = await plant(await accountOf(p), end);
		const before = mailCount(p.email);

		const r = await runRenewalNotices();
		expect(r.queued).toBeGreaterThanOrEqual(1);
		expect(await notices(sub)).toEqual([{ status: 'sent', reason: null, attempts: 1 }]);
		expect(mailCount(p.email)).toBe(before + 1);
		const mail = lastMailTo(p.email)!;
		expect(mail.kind).toBe('renewal_notice');
		const date = resetWhen(new Date(at(end))).date;
		expect(mail.subject).toBe(`Your yearly Pro plan renews on ${date} — IC-WBT`);
		expect(mail.text).toContain(`This year of it ends on ${date}.`);
		expect(mail.text).toMatch(/R\s?8\s?990[,.]00 is charged for the next year/);
		expect(mail.text).toContain('Consumer Protection Act');
		expect(mail.text).toContain('20 business days’ notice');
		expect(mail.text).toMatch(/Open your plan: \S+\/account\/plan/);

		// The next tick, and the one after: the period has had its notice.
		await runRenewalNotices();
		await runRenewalNotices();
		expect(mailCount(p.email)).toBe(before + 1);
		expect(await notices(sub)).toHaveLength(1);
		await retire(sub);
	});

	it('two ticks at once send one notice', async () => {
		const p = await person('Racer');
		const sub = await plant(await accountOf(p), endWith(60));
		const before = mailCount(p.email);
		const [a, b] = await Promise.all([runRenewalNotices(), runRenewalNotices()]);
		expect(a.sent + b.sent).toBeGreaterThanOrEqual(1);
		expect(mailCount(p.email)).toBe(before + 1);
		expect(await notices(sub)).toEqual([{ status: 'sent', reason: null, attempts: 1 }]);
		await retire(sub);
	});

	it('a missed day still sends, down to the margin; none before 60 or past it', async () => {
		const p = await person('Late');
		const account = await accountOf(p);
		const late = await plant(account, endWith(RENEWAL_LATEST_BUSINESS_DAYS));
		await runRenewalNotices();
		expect(await notices(late)).toEqual([{ status: 'sent', reason: null, attempts: 1 }]);
		await retire(late);

		// One business day too late, and one too early (a live subscription each, one at a time: one live per account).
		const tooLate = await plant(account, endWith(RENEWAL_LATEST_BUSINESS_DAYS - 1));
		await runRenewalNotices();
		expect(await notices(tooLate)).toEqual([]);
		await retire(tooLate);
		const tooEarly = await plant(account, endWith(RENEWAL_NOTICE_BUSINESS_DAYS + 1));
		await runRenewalNotices();
		expect(await notices(tooEarly)).toEqual([]);
		await retire(tooEarly);
	});

	it('files a period under its last paid day: one ending exactly at SAST midnight counts from the day before (408, issue #930)', async () => {
		const p = await person('Midnight');
		const account = await accountOf(p);
		// The last date with 60 business days before it; the day after it has 61 (so it is itself a business day).
		const lastPaid = endDatesWithin(today(), RENEWAL_NOTICE_BUSINESS_DAYS, RENEWAL_NOTICE_BUSINESS_DAYS)!.to;
		const next = addDays(lastPaid, 1);
		expect(businessDaysBetween(today(), next)).toBe(RENEWAL_NOTICE_BUSINESS_DAYS + 1);
		/** A yearly period ending at an exact instant (the machine's TZ is skewed; the instant is SAST's, rule 7). */
		const plantAt = async (end: string) =>
			(
				await asOwner(
					`INSERT INTO subscription (billing_account_id, plan_code, status, seats, period_start, period_end, cancel_at_period_end, provider, external_ref)
					 VALUES ($1, 'pro', 'active', 1, $2::timestamptz - interval '12 months', $2::timestamptz, false, 'manual', $3) RETURNING id`,
					[account, end, `renewal-${crypto.randomUUID()}`]
				)
			)[0].id as string;

		// Paid through lastPaid, ending at the midnight that starts the next day: filed under lastPaid, so queued at 60.
		const midnight = await plantAt(`${next}T00:00:00+02:00`);
		await runRenewalNotices();
		expect(await notices(midnight)).toEqual([{ status: 'sent', reason: null, attempts: 1 }]);
		// The email: this year ends on the last paid day, and renews on the next (period_end's SAST date).
		const mail = lastMailTo(p.email)!;
		const endsOn = resetWhen(new Date(at(lastPaid))).date;
		const renewsOn = resetWhen(new Date(at(next))).date;
		expect(endsOn).not.toBe(renewsOn);
		expect(mail.subject).toBe(`Your yearly Pro plan renews on ${renewsOn} — IC-WBT`);
		expect(mail.text).toContain(`This year of it ends on ${endsOn}.`);
		await retire(midnight);

		// Control: a microsecond later, the next day is paid for too, so its 61 business days are too early.
		const after = await plantAt(`${next}T00:00:00.000001+02:00`);
		await runRenewalNotices();
		expect(await notices(after)).toEqual([]);
		await retire(after);
	});

	it('leaves out a team’s account, a monthly plan, a trial and a plan already cancelling; the person’s yearly one beside them gets one', async () => {
		const p = await person('Excluded');
		const end = endWith(60);
		const teamId = (await p.call('POST', '/teams', { name: 'Renewal WUA' })).body.team.id as string;
		const [team] = await asOwner(`INSERT INTO billing_account (kind, team_id) VALUES ('team', $1) RETURNING id`, [teamId]);
		const teamSub = await plant(team.id, end, { plan: 'team' });

		const others = await Promise.all([person('Monthly'), person('Trial'), person('Cancelling')]);
		const monthly = await plant(await accountOf(others[0]), end, { months: 1 });
		const trial = await plant(await accountOf(others[1]), end, { status: 'trialing' });
		const cancelling = await plant(await accountOf(others[2]), end, { cancelling: true });
		const yearly = await plant(await accountOf(p), end);

		await runRenewalNotices();
		for (const s of [teamSub, monthly, trial, cancelling]) expect(await notices(s), s).toEqual([]);
		expect(await notices(yearly)).toEqual([{ status: 'sent', reason: null, attempts: 1 }]);
		for (const s of [teamSub, monthly, trial, cancelling, yearly]) await retire(s);
	});

	it('a notice queued for a plan cancelled before it went is skipped, not sent', async () => {
		const p = await person('Changed');
		const end = endWith(60);
		const sub = await plant(await accountOf(p), end);
		// Queued by the definer function (as a tick would), then cancelled before the send.
		const range = endDatesWithin(today(), RENEWAL_LATEST_BUSINESS_DAYS, RENEWAL_NOTICE_BUSINESS_DAYS)!;
		await withoutUser((db) => db.query('SELECT app_renewal_notice_queue($1::date, $2::date)', [range.from, range.to]));
		expect(await notices(sub)).toEqual([{ status: 'pending', reason: null, attempts: 0 }]);
		await asOwner('UPDATE subscription SET cancel_at_period_end = true WHERE id = $1', [sub]);
		const before = mailCount(p.email);
		await runRenewalNotices();
		expect(mailCount(p.email)).toBe(before);
		expect(await notices(sub)).toEqual([{ status: 'skipped', reason: 'cancelled, ended or moved to another period since it was queued', attempts: 1 }]);
		await retire(sub);
	});

	it('the queue and claim are the worker’s alone, and a member reads only their own notices', async () => {
		const p = await person('Reader');
		const other = await person('Other');
		const sub = await plant(await accountOf(p), endWith(60));
		await runRenewalNotices();
		await retire(sub);
		// Their own row (positive control); nobody else's.
		const mine = await withUser(p.id, async (db) => (await db.query('SELECT subscription_id FROM renewal_notice')).rows);
		expect(mine).toEqual([{ subscription_id: sub }]);
		const theirs = await withUser(other.id, async (db) => (await db.query('SELECT 1 FROM renewal_notice')).rows);
		expect(theirs).toEqual([]);
		await expect(withUser(p.id, (db) => db.query('SELECT app_renewal_notice_queue(current_date, current_date + 1)'))).rejects.toThrow(/only the worker/);
		await expect(withUser(p.id, (db) => db.query("SELECT * FROM app_renewal_notice_claim(10, interval '1 minute')"))).rejects.toThrow(/only the worker/);
		await expect(withUser(p.id, (db) => db.query(`INSERT INTO renewal_notice (subscription_id, period_end, user_id) VALUES ($1, now(), $2)`, [sub, p.id]))).rejects.toThrow();
	});

	it('refuses a range in the past or longer than 60 days', async () => {
		const t = today();
		await expect(withoutUser((db) => db.query('SELECT app_renewal_notice_queue($1::date, $2::date)', [addDays(t, -1), t]))).rejects.toThrow(/at most 60 days/);
		await expect(withoutUser((db) => db.query('SELECT app_renewal_notice_queue($1::date, $2::date)', [t, addDays(t, 61)]))).rejects.toThrow(/at most 60 days/);
		// Positive control: today to 60 days on is accepted.
		await expect(withoutUser((db) => db.query('SELECT app_renewal_notice_queue($1::date, $2::date)', [t, addDays(t, 60)]))).resolves.toBeDefined();
	});
});
