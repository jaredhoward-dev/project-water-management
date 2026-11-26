// The staff grant against Postgres (330_staff_grant, scripts/billing-grant.ts;
// docs/billing.md § Staff grants). A grant shows on the plan page, ends at its
// date (the tick expires it, back to Free with nothing deleted), is refused
// beside a live Stripe subscription even with --replace, replaces a mock or
// manual one only with --replace, and is revoked; every step is logged. Only
// the schema owner can grant or revoke. Runs under the workspace's skewed TZ
// (CLAUDE.md rule 7): --until is a South African date.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { type GrantArgs, parseArgs, runGrant } from '../../scripts/billing-grant.js';

type Person = Awaited<ReturnType<typeof signUp>> & { email: string };
const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;

async function person(name: string): Promise<Person> {
	const p = await signUp(name);
	const [u] = await asOwner('SELECT email FROM app_user WHERE id = $1', [p.id]);
	return Object.assign(p, { email: u.email as string });
}
const planOf = async (p: Person) => (await p.call('GET', '/account/plan')).body;
const accountOf = async (p: Person) => (await planOf(p)).account.id as string;
/** Parse as the script does, then run it as the schema owner. */
const run = (argv: string[]) => {
	const args = parseArgs(argv, 'test-operator');
	if (typeof args === 'string') throw new Error(args);
	return runGrant(OWNER_URL, args as GrantArgs);
};
const failure = async (p: Promise<unknown>) => {
	try {
		await p;
		return 'ok';
	} catch (e) {
		return `${(e as { code?: string }).code}: ${(e as Error).message}`;
	}
};
const log = async (account: string) =>
	(await asOwner('SELECT action, plan_code, reason, granted_by FROM billing_grant_log WHERE billing_account_id = $1 ORDER BY created_at, id', [account])) as {
		action: string;
		plan_code: string;
		reason: string;
		granted_by: string;
	}[];
/** A Stripe or mock subscription planted live, as the webhook would leave it. */
const plant = async (account: string, provider: 'stripe' | 'mock') =>
	(
		await asOwner(
			`INSERT INTO subscription (billing_account_id, plan_code, status, period_start, period_end, provider, external_ref)
			 VALUES ($1, 'pro', 'active', now(), now() + interval '30 days', $2, $3) RETURNING id`,
			[account, provider, `grant-${crypto.randomUUID()}`]
		)
	)[0].id as string;
const statusOf = async (sub: string) => ((await asOwner('SELECT status FROM subscription WHERE id = $1', [sub])) as { status: string }[])[0]!.status;

let founder: Person;
let outsider: Person;
beforeAll(async () => {
	founder = await person('GrantFounder');
	outsider = await person('GrantOutsider');
});

describe('app_staff_grant_plan', () => {
	it('grants a plan the plan page shows, through the SAST date given, and logs it; the person reads their log, an outsider not', async () => {
		const account = await accountOf(founder);
		expect((await planOf(founder)).plan.code).toBe('free');
		const out = await run([founder.email, 'pro', '--until', '2099-01-15', '--reason', 'Founding user: first catchment pilot']);
		expect(out.join('\n')).toMatch(/^Granted pro to .* through 2099-01-15 \(it ends 2099-01-16 00:00 SAST\)\. Logged: Founding user/);
		const page = await planOf(founder);
		expect(page.plan.code).toBe('pro');
		expect(page.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
		// The end of 15 January in South Africa, whatever this process's TZ is (rule 7).
		expect(new Date(page.subscription.periodEnd).toISOString()).toBe('2099-01-15T22:00:00.000Z');
		const [sub] = await asOwner(`SELECT provider, external_ref FROM subscription WHERE billing_account_id = $1 AND status = 'active'`, [account]);
		expect(sub).toEqual({ provider: 'manual', external_ref: null });
		expect(await log(account)).toEqual([{ action: 'grant', plan_code: 'pro', reason: 'Founding user: first catchment pilot', granted_by: 'test-operator' }]);
		// The person reads their own grant log (positive control); an outsider sees none of it.
		const mine = await withUser(founder.id, async (db) => (await db.query('SELECT action FROM billing_grant_log WHERE billing_account_id = $1', [account])).rows);
		expect(mine).toEqual([{ action: 'grant' }]);
		const theirs = await withUser(outsider.id, async (db) => (await db.query('SELECT action FROM billing_grant_log WHERE billing_account_id = $1', [account])).rows);
		expect(theirs).toEqual([]);
		// Granting again without --replace is refused; with it, the old grant is revoked (logged) and the new one stands.
		expect(await failure(run([founder.email, 'team', '--reason', 'Moved to team']))).toMatch(/^23505: .*live manual subscription.*replace/);
		await run([founder.email, 'team', '--reason', 'Moved to team', '--replace']);
		expect((await planOf(founder)).plan.code).toBe('team');
		expect((await planOf(founder)).subscription.periodEnd).toBeNull();
		expect((await log(account)).map((r) => r.action)).toEqual(['grant', 'revoke', 'grant']);
		expect((await log(account))[1]!.reason).toBe('replaced: Moved to team');
		// Revoked: back to Free, nothing deleted.
		const revoked = await run([founder.email, '--revoke', '--reason', 'Pilot over']);
		expect(revoked.join('\n')).toMatch(/Revoked .* team grant; the account is on Free now/);
		expect((await planOf(founder)).plan.code).toBe('free');
		expect((await asOwner('SELECT count(*)::int AS n FROM subscription WHERE billing_account_id = $1', [account]))[0].n).toBe(2);
		expect((await log(account)).map((r) => r.action)).toEqual(['grant', 'revoke', 'grant', 'revoke']);
		expect(await failure(run([founder.email, '--revoke', '--reason', 'again']))).toMatch(/^P0002: the account has no live staff grant/);
		// --list prints the log.
		const listed = await run([founder.email, '--list']);
		expect(listed[0]).toMatch(/on free now/);
		expect(listed).toHaveLength(5);
	});

	it('expires a grant past its end on the tick: Free again, the rows kept, the expiry logged', async () => {
		const p = await person('GrantExpiring');
		const account = await accountOf(p);
		await run([p.email, 'pro', '--until', '2099-06-30', '--reason', 'Trial deal']);
		// The end passes (planted as the owner; time can't be moved).
		await asOwner(
			`UPDATE subscription SET period_start = now() - interval '2 days', period_end = now() - interval '1 minute' WHERE billing_account_id = $1 AND provider = 'manual' AND status = 'active'`,
			[account]
		);
		expect(await withoutUser(async (db) => (await db.query<{ n: number }>('SELECT app_staff_grant_expire() AS n')).rows[0]!.n)).toBeGreaterThanOrEqual(1);
		expect((await planOf(p)).plan.code).toBe('free');
		expect(await asOwner('SELECT status FROM subscription WHERE billing_account_id = $1', [account])).toEqual([{ status: 'expired' }]);
		expect((await log(account)).map((r) => [r.action, r.granted_by])).toEqual([
			['grant', 'test-operator'],
			['expire', 'expiry']
		]);
		// A signed-in user can't run the expiry (only the worker's context).
		expect(await failure(withUser(p.id, (db) => db.query('SELECT app_staff_grant_expire()')))).toMatch(/^42501/);
	});

	it('the worker tick runs the expiry: a lapsed grant is counted in staffGrantsExpired and the account is Free', async () => {
		const p = await person('GrantTick');
		const account = await accountOf(p);
		await run([p.email, 'pro', '--until', '2099-06-30', '--reason', 'Tick deal']);
		await asOwner(
			`UPDATE subscription SET period_start = now() - interval '2 days', period_end = now() - interval '1 minute' WHERE billing_account_id = $1 AND provider = 'manual' AND status = 'active'`,
			[account]
		);
		const tick = await runTick({ feeds: false, reports: false, alerts: false, maxJobs: 0 });
		expect(tick.staffGrantsExpired).toBeGreaterThanOrEqual(1);
		expect((await planOf(p)).plan.code).toBe('free');
	});

	it('expires a lapsed grant the tick hasn’t reached before a new grant, so it never blocks one', async () => {
		const p = await person('GrantLapsed');
		const account = await accountOf(p);
		await run([p.email, 'pro', '--until', '2099-06-30', '--reason', 'First deal']);
		await asOwner(
			`UPDATE subscription SET period_start = now() - interval '2 days', period_end = now() - interval '1 minute' WHERE billing_account_id = $1 AND status = 'active'`,
			[account]
		);
		await run([p.email, 'pro', '--reason', 'Renewed deal']);
		expect((await log(account)).map((r) => r.action)).toEqual(['grant', 'expire', 'grant']);
		expect((await planOf(p)).plan.code).toBe('pro');
	});

	it('refuses a grant beside a live Stripe subscription, even with --replace, and leaves it untouched', async () => {
		const p = await person('GrantStripe');
		const account = await accountOf(p);
		const stripe = await plant(account, 'stripe');
		expect(await failure(run([p.email, 'team', '--reason', 'Invoice 12']))).toMatch(/^23505: .*live Stripe subscription.*cancel it in Stripe/);
		expect(await failure(run([p.email, 'team', '--reason', 'Invoice 12', '--replace']))).toMatch(/^23505: .*Stripe/);
		expect(await statusOf(stripe)).toBe('active');
		expect(await log(account)).toEqual([]);
		// And --revoke has nothing to revoke: a Stripe subscription isn't a grant.
		expect(await failure(run([p.email, '--revoke', '--reason', 'no']))).toMatch(/^P0002/);
		expect(await statusOf(stripe)).toBe('active');
	});

	it('replaces a live mock subscription only with --replace', async () => {
		const p = await person('GrantMock');
		const account = await accountOf(p);
		const mock = await plant(account, 'mock');
		expect(await failure(run([p.email, 'team', '--reason', 'Invoice 7']))).toMatch(/^23505: .*live mock subscription/);
		expect(await statusOf(mock)).toBe('active');
		await run([p.email, 'team', '--reason', 'Invoice 7', '--replace']);
		expect(await statusOf(mock)).toBe('canceled');
		expect((await planOf(p)).plan.code).toBe('team');
		expect((await log(account)).map((r) => r.action)).toEqual(['grant']);
	});

	it('grants a team’s account by its id; its admin reads the log, a member not', async () => {
		const admin = await person('GrantTeamAdmin');
		const member = await person('GrantTeamMember');
		const teamId = (await admin.call('POST', '/teams', { name: 'Grant WUA' })).body.team.id as string;
		await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' });
		await run([teamId, 'team', '--until', '2099-12-31', '--reason', 'B2B invoice INV-1']);
		const [acct] = await asOwner('SELECT id FROM billing_account WHERE team_id = $1', [teamId]);
		const read = (u: Person) => withUser(u.id, async (db) => (await db.query('SELECT reason FROM billing_grant_log WHERE billing_account_id = $1', [acct.id])).rows);
		expect(await read(admin)).toEqual([{ reason: 'B2B invoice INV-1' }]);
		expect(await read(member)).toEqual([]);
	});

	it('grants a team its included seats by default and more with --seats, which a new grant changes; refuses seats the plan doesn’t sell', async () => {
		const admin = await person('GrantSeatsAdmin');
		const teamId = (await admin.call('POST', '/teams', { name: 'Grant seats WUA' })).body.team.id as string;
		const seatsNow = async () => (await admin.call('GET', `/teams/${teamId}/plan`)).body.subscription.seats as number;
		await run([teamId, 'team', '--until', '2099-12-31', '--reason', 'B2B invoice INV-2']);
		expect(await seatsNow()).toBe(3);
		await run([teamId, 'team', '--until', '2099-12-31', '--seats', '6', '--reason', 'B2B invoice INV-3', '--replace']);
		expect(await seatsNow()).toBe(6);
		const [acct] = await asOwner('SELECT id FROM billing_account WHERE team_id = $1', [teamId]);
		const grant = (plan: string, seats: number) => failure(asOwner('SELECT app_staff_grant_plan($1, $2, NULL, $3, $4, true, $5)', [acct.id, plan, 'x', 'op', seats]));
		expect(await grant('team', 2)).toMatch(/^22023: the team plan includes 3 seats/);
		expect(await grant('pro', 2)).toMatch(/^22023: the pro plan sells no extra seats/);
		expect(await seatsNow()).toBe(6);
		expect(parseArgs(['a@example.com', 'team', '--seats', '0', '--reason', 'x'], 'op')).toMatch(/--seats is a whole number/);
		expect(parseArgs(['a@example.com', '--revoke', '--seats', '4', '--reason', 'x'], 'op')).toMatch(/--revoke takes no/);
	});

	it('refuses a bad plan, a past end, a blank reason, and an unknown person or account', async () => {
		const account = await accountOf(outsider);
		const grant = (plan: string, until: string | null, reason: string) =>
			failure(asOwner('SELECT app_staff_grant_plan($1, $2, $3, $4, $5)', [account, plan, until, reason, 'op']));
		expect(await grant('free', null, 'x')).toMatch(/^22023/);
		expect(await grant('gold', null, 'x')).toMatch(/^22023/);
		expect(await grant('pro', '2000-01-01T00:00:00Z', 'x')).toMatch(/^22023: a grant ends in the future/);
		expect(await grant('pro', null, '   ')).toMatch(/^22023: give a reason/);
		expect(await failure(asOwner('SELECT app_staff_grant_plan(gen_random_uuid(), $1, NULL, $2, $3)', ['pro', 'x', 'op']))).toMatch(/^P0002/);
		expect(await failure(run(['nobody-here@example.com', 'pro', '--reason', 'x']))).toMatch(/no account with the address nobody-here@example.com/);
		expect(await log(account)).toEqual([]);
	});

	it('is the schema owner’s alone: water_app, signed in or not, can’t grant, revoke or write the log', async () => {
		const account = await accountOf(outsider);
		for (const as of [(f: Parameters<typeof withoutUser>[0]) => withoutUser(f), (f: Parameters<typeof withoutUser>[0]) => withUser(outsider.id, f)]) {
			expect(await failure(as((db) => db.query(`SELECT app_staff_grant_plan($1, 'pro', NULL, 'self-service', 'me')`, [account])))).toMatch(/^42501/);
			expect(await failure(as((db) => db.query(`SELECT app_staff_revoke_grant($1, 'x', 'me')`, [account])))).toMatch(/^42501/);
			expect(
				await failure(as((db) => db.query(`INSERT INTO billing_grant_log (billing_account_id, action, plan_code, reason, granted_by) VALUES ($1, 'grant', 'pro', 'x', 'me')`, [account])))
			).toMatch(/^42501/);
		}
		expect((await planOf(outsider)).plan.code).toBe('free');
	});
});
