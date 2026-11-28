// The owners' plan emails against Postgres (346_billing_notices, billing/planNotices.ts; docs/billing.md § Plan
// emails). Runs under the workspace's skewed TZ (CLAUDE.md rule 7): the dates are South Africa's.
//  - a lapse past Free's limit with enforcement off sends nothing (and queues nothing);
//  - enforced, the grace email goes once to the account's owner, naming what will pause and when, what stays on, and
//    only the catchments the owner can read (one they left is counted, never named; positive control: theirs named);
//  - the pause email goes once when the pause lands, and the grace email isn't sent after it;
//  - the trial email goes once 3 days before a reverse trial ends, not 5 days before, and not for a staff grant;
//  - the queue is the worker's alone; the preview answers the account's owner only (positive control).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, disableFeedsAfterFile, lastMailTo, mailCount, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { resetWhen } from '../mail/templates.js';

type Person = Awaited<ReturnType<typeof signUp>> & { email: string };

const alertBody = { rules: [{ kind: 'ewr_forecast_fail', threshold: 5, enabled: true }] };
const made: string[] = [];

async function person(name: string): Promise<Person> {
	const p = await signUp(name);
	const [u] = await asOwner('SELECT email FROM app_user WHERE id = $1', [p.id]);
	return Object.assign(p, { email: u.email as string });
}
const accountOf = async (pid: string) =>
	((await asOwner('SELECT billing_account_id AS a FROM project WHERE id = $1', [pid])) as { a: string }[])[0]!.a;
const notices = async (account: string) =>
	(await asOwner('SELECT kind, status, reason FROM billing_notice WHERE billing_account_id = $1 ORDER BY created_at, kind', [account])) as {
		kind: string;
		status: string;
		reason: string | null;
	}[];
const tick = () => runTick({ feeds: false, reports: false, alerts: false, maxJobs: 0 });
const failure = async (p: Promise<unknown>) => {
	try {
		await p;
		return 'ok';
	} catch (e) {
		return String((e as { code?: string }).code);
	}
};

disableFeedsAfterFile();

afterEach(() => {
	delete process.env.BILLING_ENFORCED;
});

afterAll(() => retirePendingJobs(...made));

describe('346: the grace and pause emails', () => {
	let owner: Person;
	let other: Person;
	let a: string;
	let b: string;
	let c: string;
	let account: string;

	beforeAll(async () => {
		owner = await person('NoticeOwner');
		other = await person('NoticeOther');
		for (const name of ['Notice Alpha', 'Notice Bravo', 'Notice Charlie']) {
			const id = (await owner.call('POST', '/projects', { name })).body.project.id as string;
			made.push(id);
			// An alert rule makes it live (338).
			expect((await owner.call('PUT', `/projects/${id}/alert-rules`, alertBody)).status).toBe(200);
		}
		[a, b, c] = made as [string, string, string];
		account = await accountOf(a);
		// Charlie is handed to another owner and left: still billed to the account, no longer the owner's to read.
		await asOwner(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'owner')`, [c, other.id]);
		await asOwner(`DELETE FROM project_member WHERE project_id = $1 AND user_id = $2`, [c, owner.id]);
		// The owner keeps Alpha live; Bravo and Charlie are past Free's one.
		await asOwner('UPDATE billing_account SET kept_project_id = $2 WHERE id = $1', [account, a]);
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'active', 'mock')`, [account]);
		// The lapse. No grace starts until an enforced tick stamps it (409).
		await asOwner(`UPDATE subscription SET status = 'canceled' WHERE billing_account_id = $1 AND status = 'active'`, [account]);
	});

	it('with enforcement off, a lapse past Free’s limit sends nothing and queues nothing', async () => {
		const before = mailCount(owner.email);
		await tick();
		expect(mailCount(owner.email)).toBe(before);
		expect(await notices(account)).toEqual([]);
	});

	it('enforced, the grace email goes to the owner once: what pauses and when, what stays on, nothing deleted', async () => {
		process.env.BILLING_ENFORCED = 'true';
		const before = mailCount(owner.email);
		const otherBefore = mailCount(other.email);
		await tick();
		expect(mailCount(owner.email)).toBe(before + 1);
		const mail = lastMailTo(owner.email)!;
		const [since] = (await asOwner('SELECT over_free_since AS t FROM billing_account WHERE id = $1', [account])) as { t: Date }[];
		const date = resetWhen(new Date(since!.t.getTime() + 14 * 86_400_000), 'en').date;
		expect(mail.kind).toBe('plan_notice');
		expect(mail.subject).toBe(`Some catchments’ automatic updates pause on ${date} — IC-WBT`);
		expect(mail.text).toContain(`Unless you choose otherwise, on ${date} the data feeds, alerts and automatic runs of these catchments pause:`);
		// Positive control: the owner's own catchments are named.
		expect(mail.text).toContain('\nNotice Bravo\n');
		expect(mail.text).toContain('These stay on: Notice Alpha.');
		// The one they left is counted, never named.
		expect(mail.text).toContain('and 1 more catchment of the account that you are not a member of.');
		expect(mail.text).not.toContain('Notice Charlie');
		expect(mail.html).not.toContain('Notice Charlie');
		expect(mail.text).toContain('Nothing is deleted.');
		expect(mail.text).toContain('http://localhost:7777/account/plan');
		// The other owner of Charlie isn't an owner of the account: no email.
		expect(mailCount(other.email)).toBe(otherBefore);
		expect(await notices(account)).toEqual([{ kind: 'grace', status: 'sent', reason: null }]);
		// Not resent.
		await tick();
		expect(mailCount(owner.email)).toBe(before + 1);
	});

	it('the pause email goes once when the pause lands, and no second grace email', async () => {
		process.env.BILLING_ENFORCED = 'true';
		// The grace's start moved back past the 14 days: the same occurrence for both emails from here on.
		await asOwner(`UPDATE billing_account SET over_free_since = now() - interval '15 days' WHERE id = $1`, [account]);
		const before = mailCount(owner.email);
		await tick();
		const paused = (await asOwner('SELECT project_id AS id FROM project_plan_pause WHERE project_id = ANY($1::uuid[]) ORDER BY 1', [[a, b, c]])) as { id: string }[];
		expect(paused.map((r) => r.id)).toEqual([b, c].sort());
		expect(mailCount(owner.email)).toBe(before + 1);
		const mail = lastMailTo(owner.email)!;
		expect(mail.subject).toBe('Some catchments’ automatic updates have paused — IC-WBT');
		expect(mail.text).toContain('\nNotice Bravo\n');
		expect(mail.text).not.toContain('Notice Charlie');
		expect(mail.text).toContain('and 1 more catchment');
		await tick();
		expect(mailCount(owner.email)).toBe(before + 1);
		expect((await notices(account)).filter((n) => n.kind === 'paused')).toEqual([{ kind: 'paused', status: 'sent', reason: null }]);
	});

	it('the preview answers the account’s owner only (positive control: the owner sees it)', async () => {
		const preview = (uid: string) =>
			withUser(uid, async (db) => (await db.query<{ project_id: string | null; keeps: boolean }>('SELECT project_id, keeps FROM app_plan_pause_preview($1)', [account])).rows);
		const mine = await preview(owner.id);
		// The kept one first; the other two in 341's order (most recently active first).
		expect(mine[0]).toEqual({ project_id: a, keeps: true });
		expect(mine.slice(1)).toEqual(expect.arrayContaining([{ project_id: b, keeps: false }, { project_id: null, keeps: false }]));
		expect(mine).toHaveLength(3);
		expect(await preview(other.id)).toEqual([]);
	});

	afterAll(async () => {
		await asOwner('DELETE FROM project_plan_pause WHERE project_id = ANY($1::uuid[])', [[a, b, c]]);
		await asOwner('UPDATE billing_account SET over_free_since = NULL WHERE id = $1', [account]);
		await asOwner(`UPDATE subscription SET status = 'expired' WHERE billing_account_id = $1`, [account]);
	});
});

describe('346: the trial-ending email', () => {
	async function trialist(name: string, endsIn: string, provider = 'manual', status = 'trialing') {
		const p = await person(name);
		const acct = (await p.call('GET', '/account/plan')).body.account.id as string;
		await asOwner(
			`INSERT INTO subscription (billing_account_id, plan_code, status, provider, period_start, period_end, trial_end, cancel_at_period_end)
			 VALUES ($1, 'pro', $3, $4, now() - interval '11 days', now() + $2::interval, now() + $2::interval, true)`,
			[acct, endsIn, status, provider]
		);
		return { p, acct };
	}

	it('goes once 3 days before a reverse trial ends, even with enforcement off; not 5 days before, not for a staff grant', async () => {
		const due = await trialist('TrialDue', '2 days 12 hours');
		const early = await trialist('TrialEarly', '5 days');
		const grant = await trialist('TrialGrant', '2 days', 'manual', 'active');
		// Each has had its sign-up's email.
		const [d0, e0, g0] = [mailCount(due.p.email), mailCount(early.p.email), mailCount(grant.p.email)];
		try {
			await tick();
			expect(mailCount(due.p.email)).toBe(d0 + 1);
			const mail = lastMailTo(due.p.email)!;
			const [s] = (await asOwner('SELECT trial_end AS t FROM subscription WHERE billing_account_id = $1', [due.acct])) as { t: Date }[];
			const date = resetWhen(s!.t, 'en').date;
			expect(mail.subject).toBe(`Your Pro trial ends on ${date} — IC-WBT`);
			expect(mail.text).toContain(`Your free Pro trial for ${due.p.email} ends on ${date}.`);
			expect(mail.text).toContain('Nothing is deleted when the trial ends.');
			expect(mailCount(early.p.email)).toBe(e0);
			expect(mailCount(grant.p.email)).toBe(g0);
			await tick();
			expect(mailCount(due.p.email)).toBe(d0 + 1);
			expect(await notices(due.acct)).toEqual([{ kind: 'trial_ending', status: 'sent', reason: null }]);
		} finally {
			await asOwner(`UPDATE subscription SET status = 'expired' WHERE billing_account_id = ANY($1::uuid[])`, [[due.acct, early.acct, grant.acct]]);
		}
	});

	it('a trial ended or replaced before the send is skipped, not sent', async () => {
		const t = await trialist('TrialGone', '1 day');
		// Queued by the worker, then the trial replaced (a paid plan) before the send.
		await withoutUser((db) => db.query('SELECT app_billing_notice_queue()'));
		await asOwner(`UPDATE subscription SET status = 'expired' WHERE billing_account_id = $1`, [t.acct]);
		const before = mailCount(t.p.email);
		await tick();
		expect(mailCount(t.p.email)).toBe(before);
		expect(await notices(t.acct)).toEqual([{ kind: 'trial_ending', status: 'skipped', reason: 'the trial ended, was replaced or is no longer theirs' }]);
	});
});

describe('346: who may queue', () => {
	it('the app role as a person can’t queue, claim or finish', async () => {
		const p = await signUp('NoticeCaller');
		await withUser(p.id, async (db) => {
			await db.query('SAVEPOINT s');
			expect(await failure(db.query('SELECT app_billing_notice_queue()'))).toBe('42501');
			await db.query('ROLLBACK TO SAVEPOINT s');
			expect(await failure(db.query(`SELECT * FROM app_billing_notice_claim(1, interval '1 minute')`))).toBe('42501');
			await db.query('ROLLBACK TO SAVEPOINT s');
			expect(await failure(db.query(`SELECT app_billing_notice_finish($1, 'grace', now(), $1, 'sent')`, [p.id]))).toBe('42501');
		});
	});
});
