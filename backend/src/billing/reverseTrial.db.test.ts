// The 14-day Pro reverse trial against Postgres (342_reverse_trial, billing/reverseTrial.ts; docs/billing.md § Pro:
// the reverse trial):
//   - off (REVERSE_TRIAL unset, or BILLING_ENFORCED off) verifying grants nothing and records no claim;
//   - on, the first verification starts Pro as trialing for plan.trial_days, once per canonical email: a canonical
//     duplicate (dots, +tag, googlemail.com) gets none, nor does the same address after the account is deleted;
//   - an unverified caller gets none (and a verified one does, the positive control);
//   - the tick expires it to Free, nothing deleted;
//   - the trial's assistant caps ($2 in all, $1 a SAST day) refuse only with billing enforced, and the Free pool
//     counts the trial's spend;
//   - the claim table is closed to water_app.
// Runs under the workspace's skewed TZ (CLAUDE.md rule 7): the days are worked out by Postgres.
import { LEGAL_VERSION } from '@water-management/engine/legal';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { anon, app, asOwner, lastMailTo, tokenIn } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { TRIAL_CAPS } from '../assistant/dollarCaps.js';
import { reverseTrialHash } from './reverseTrial.js';

const ORIGIN = 'http://localhost:7777';
const PRICE = 2.5; // micro-USD a weighted token
const MIN = 1_000; // tokens: a floor of 2 500 micro-USD
const MAX = 150_000;

afterEach(() => {
	vi.unstubAllEnvs();
});
const on = () => {
	vi.stubEnv('BILLING_ENFORCED', 'true');
	vi.stubEnv('REVERSE_TRIAL', 'true');
};

/** A unique local part for this run (the test database outlives it, and a claim is forever). */
const local = () => `rt${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;

interface Person {
	id: string;
	email: string;
	call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
}

/** Sign up with `email`, then (unless `verify` is false) open the emailed link, as a person would. */
async function person(email: string, verify = true): Promise<Person> {
	const res = await app.request('/auth/register', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({ email, password: 'correct horse', displayName: 'Trial', acceptTerms: LEGAL_VERSION })
	});
	expect(res.status).toBe(202);
	if (verify) expect((await anon('POST', '/auth/verify-email', { token: tokenIn(lastMailTo(email)) })).status).toBe(200);
	const [u] = await asOwner('SELECT id FROM app_user WHERE lower(email) = lower($1)', [email]);
	const id = u!.id as string;
	const login = await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ email, password: 'correct horse' }) });
	const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
	const call = async (method: string, path: string, body?: unknown) => {
		const r = await app.request(path, { method, headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
		const text = await r.text();
		return { status: r.status, body: text ? JSON.parse(text) : null };
	};
	return { id, email, call };
}

/** The person's live subscription, as the schema owner sees it. */
const liveSub = async (p: Person) =>
	(
		await asOwner(
			`SELECT s.plan_code, s.status, s.provider, s.cancel_at_period_end, round(extract(epoch FROM s.trial_end - s.period_start) / 86400)::int AS days, s.trial_end = s.period_end AS ends_together
			 FROM subscription s JOIN billing_account a ON a.id = s.billing_account_id
			 WHERE a.user_id = $1 AND s.status IN ('trialing', 'active', 'past_due')`,
			[p.id]
		)
	)[0];
const accountOf = async (p: Person) => ((await asOwner('SELECT id FROM billing_account WHERE user_id = $1', [p.id]))[0]?.id as string | undefined) ?? null;

describe('granting the reverse trial', () => {
	it('off (the default, or REVERSE_TRIAL without BILLING_ENFORCED) grants nothing and records no claim', async () => {
		const a = await person(`${local()}@example.com`);
		expect(await liveSub(a)).toBeUndefined();
		vi.stubEnv('REVERSE_TRIAL', 'true');
		const b = await person(`${local()}@example.com`);
		expect(await liveSub(b)).toBeUndefined();
		const claims = await asOwner('SELECT 1 FROM reverse_trial_claim WHERE email_hash = ANY($1)', [[reverseTrialHash(a.email), reverseTrialHash(b.email)]]);
		expect(claims).toEqual([]);
	});

	it('on, verifying starts Pro as trialing for 14 days, logged, and the plan page shows it', async () => {
		on();
		const p = await person(`${local()}@example.com`);
		expect(await liveSub(p)).toEqual({ plan_code: 'pro', status: 'trialing', provider: 'manual', cancel_at_period_end: true, days: 14, ends_together: true });
		const plan = (await p.call('GET', '/account/plan')).body;
		expect(plan.plan.code).toBe('pro');
		expect(plan.subscription.status).toBe('trialing');
		expect(Date.parse(plan.subscription.trialEnd)).toBeGreaterThan(Date.now() + 13 * 86_400_000);
		const log = await asOwner(`SELECT l.action, l.granted_by FROM billing_grant_log l JOIN billing_account a ON a.id = l.billing_account_id WHERE a.user_id = $1`, [p.id]);
		expect(log).toEqual([{ action: 'grant', granted_by: 'reverse trial' }]);
		// The claim is the canonical address's hash, never the address.
		const [claim] = await asOwner('SELECT email_hash FROM reverse_trial_claim WHERE email_hash = $1', [reverseTrialHash(p.email)]);
		expect(claim!.email_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await asOwner('SELECT 1 FROM reverse_trial_claim WHERE email_hash LIKE $1', [`%${p.email}%`])).toEqual([]);
	});

	it('once per canonical email: a Gmail duplicate (dots, +tag, googlemail.com) gets none, nor does the address after deletion', async () => {
		on();
		const l = local();
		const first = await person(`${l.slice(0, 6)}.${l.slice(6)}+one@googlemail.com`);
		expect((await liveSub(first))?.status).toBe('trialing');
		const dup = await person(`${l}@gmail.com`);
		expect(await liveSub(dup)).toBeUndefined();
		expect(await accountOf(dup)).not.toBeNull(); // the account exists; it is simply Free
		// Deleting the first account keeps the claim (no address, no account link), so signing up again gets none.
		await asOwner('DELETE FROM app_user WHERE id = $1', [first.id]);
		expect(await asOwner('SELECT 1 FROM reverse_trial_claim WHERE email_hash = $1', [reverseTrialHash(first.email)])).toHaveLength(1);
		const again = await person(`${l}+two@gmail.com`);
		expect(await liveSub(again)).toBeUndefined();
	});

	it('never without a verified address; the same person verified later gets it (positive control)', async () => {
		on();
		const email = `${local()}@example.com`;
		const p = await person(email, false);
		// Called directly as the unverified person: refused, nothing claimed.
		const r = await withUser(p.id, (db) => db.query('SELECT app_reverse_trial_start($1) AS o', [reverseTrialHash(email)]));
		expect(r.rows[0].o).toBe('unverified');
		expect(await asOwner('SELECT 1 FROM reverse_trial_claim WHERE email_hash = $1', [reverseTrialHash(email)])).toEqual([]);
		expect(await liveSub(p)).toBeUndefined();
		expect((await anon('POST', '/auth/verify-email', { token: tokenIn(lastMailTo(email)) })).status).toBe(200);
		expect((await liveSub(p))?.status).toBe('trialing');
	});

	it('a live plan already there (a staff grant) keeps it and claims nothing', async () => {
		const p = await person(`${local()}@example.com`);
		const account = (await accountOf(p)) ?? ((await withUser(p.id, (db) => db.query('SELECT app_my_billing_account() AS a'))).rows[0].a as string);
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'team', 'active', 'manual')`, [account]);
		on();
		const r = await withUser(p.id, (db) => db.query('SELECT app_reverse_trial_start($1) AS o', [reverseTrialHash(p.email)]));
		expect(r.rows[0].o).toBe('live');
		expect(await asOwner('SELECT 1 FROM reverse_trial_claim WHERE email_hash = $1', [reverseTrialHash(p.email)])).toEqual([]);
	});

	it('the tick ends it: back to Free, expired and logged, nothing deleted; only the worker may run the expiry', async () => {
		on();
		const p = await person(`${local()}@example.com`);
		const projectId = (await p.call('POST', '/projects', { name: 'Trial catchment' })).body.project.id as string;
		await asOwner(
			`UPDATE subscription s SET period_start = now() - interval '15 days', period_end = now() - interval '1 minute', trial_end = now() - interval '1 minute'
			 FROM billing_account a WHERE a.id = s.billing_account_id AND a.user_id = $1 AND s.status = 'trialing'`,
			[p.id]
		);
		await expect(withUser(p.id, (db) => db.query('SELECT app_reverse_trial_expire()'))).rejects.toMatchObject({ code: '42501' });
		const tick = await runTick({ feeds: false, reports: false, alerts: false, maxJobs: 0 });
		expect(tick.reverseTrialsExpired).toBeGreaterThanOrEqual(1);
		expect((await p.call('GET', '/account/plan')).body.plan.code).toBe('free');
		expect((await p.call('GET', `/projects/${projectId}`)).status).toBe(200);
		const log = await asOwner(`SELECT l.action FROM billing_grant_log l JOIN billing_account a ON a.id = l.billing_account_id WHERE a.user_id = $1 ORDER BY l.created_at`, [p.id]);
		expect(log.map((r) => r.action)).toEqual(['grant', 'expire']);
	});

	it('keeps the claim table closed to water_app', async () => {
		const p = await person(`${local()}@example.com`);
		await expect(withUser(p.id, (db) => db.query('SELECT * FROM reverse_trial_claim'))).rejects.toMatchObject({ code: '42501' });
	});
});

describe('the trial’s assistant caps', () => {
	// The pool is every Free and trial account's: leave none of this file's spend in it for the next file.
	const trialProjects: string[] = [];
	afterAll(async () => {
		await asOwner('DELETE FROM assistant_reservation WHERE project_id = ANY($1)', [trialProjects]);
		await asOwner('DELETE FROM assistant_usage WHERE project_id = ANY($1)', [trialProjects]);
		await asOwner('DELETE FROM assistant_day_usage WHERE billing_account_id IN (SELECT billing_account_id FROM project WHERE id = ANY($1))', [trialProjects]);
	});
	/** A person on a reverse trial, with a project billed to their account. */
	async function trialist() {
		on();
		const p = await person(`${local()}@example.com`);
		const projectId = (await p.call('POST', '/projects', { name: 'Trial assistant' })).body.project.id as string;
		const account = (await accountOf(p))!;
		expect((await liveSub(p))?.status).toBe('trialing');
		trialProjects.push(projectId);
		return { p, projectId, account };
	}
	const begin = (p: Person, pid: string, pool = 1e15) =>
		withUser(p.id, async (db) => {
			const { rows } = await db.query(
				`SELECT outcome, wait_seconds, budget::float8 AS budget, pool_used_usd_micros::float8 AS pool_used, pool_usd_micros::float8 AS pool
				 FROM app_assistant_begin($1, 1000000000, 1000, 1000000000, 10000000000000, $2, $3, 300, $4, 300000, 20, $5)`,
				[pid, MAX, MIN, PRICE, pool]
			);
			return rows[0] as { outcome: string; wait_seconds: number; budget: number | null; pool_used: number | null; pool: number | null };
		});
	const sastDay = async (offset = 0) => (await asOwner(`SELECT ((now() AT TIME ZONE 'Africa/Johannesburg')::date + $1::int)::text AS d`, [offset]))[0]!.d as string;
	const dayRow = (p: Person, account: string, day: string, usd: number) =>
		asOwner(
			`INSERT INTO assistant_day_usage (billing_account_id, user_id, day, cost_usd_micros) VALUES ($1, $2, $3, $4)
			 ON CONFLICT (billing_account_id, day, user_id) DO UPDATE SET cost_usd_micros = EXCLUDED.cost_usd_micros`,
			[account, p.id, day, usd]
		);
	const backdate = (p: Person, days: number) =>
		asOwner(`UPDATE subscription s SET period_start = now() - make_interval(days => $2) FROM billing_account a WHERE a.id = s.billing_account_id AND a.user_id = $1 AND s.status = 'trialing'`, [p.id, days]);

	it('pins the SQL caps to dollarCaps.ts TRIAL_CAPS', async () => {
		const [c] = await asOwner('SELECT total_usd_micros::float8 AS t, day_usd_micros::float8 AS d FROM assistant_trial_caps()');
		expect({ totalUsdMicros: c!.t, dayUsdMicros: c!.d }).toEqual(TRIAL_CAPS);
	});

	it('a fresh trial begins, on Sonnet-priced budget cut to the trial’s day, not Free’s $0.30 (positive control)', async () => {
		const { p, projectId } = await trialist();
		const r = await begin(p, projectId);
		expect(r.outcome).toBe('ok');
		// $1 at 2.5 micro-USD a token is 400 000 tokens, above the turn's 150 000: the turn's own max binds.
		expect(r.budget).toBe(MAX);
	});

	it('today’s $1 refuses as trial_day until 00:00 SAST; yesterday’s spend counts only toward the $2', async () => {
		const { p, projectId, account } = await trialist();
		await backdate(p, 3);
		await dayRow(p, account, await sastDay(-1), 900_000);
		expect((await begin(p, projectId)).outcome).toBe('ok');
		await asOwner('DELETE FROM assistant_reservation WHERE project_id = $1', [projectId]);
		await dayRow(p, account, await sastDay(), TRIAL_CAPS.dayUsdMicros);
		const r = await begin(p, projectId);
		expect(r.outcome).toBe('trial_day');
		const [w] = await asOwner(`SELECT extract(epoch FROM ((((now() AT TIME ZONE 'Africa/Johannesburg')::date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg') - now()))::int AS s`);
		expect(Math.abs(r.wait_seconds - Number(w!.s))).toBeLessThanOrEqual(2);
	});

	it('the $2 over the trial refuses as trial, waiting to the trial’s end; spend before the trial’s first day doesn’t count', async () => {
		const { p, projectId, account } = await trialist();
		await backdate(p, 3);
		await dayRow(p, account, await sastDay(-5), 5_000_000); // before the trial
		await dayRow(p, account, await sastDay(-2), 900_000);
		await dayRow(p, account, await sastDay(-1), 900_000);
		// $1.80 spent, $0.20 left: the budget is what $0.20 buys.
		const ok = await begin(p, projectId);
		expect(ok.outcome).toBe('ok');
		expect(ok.budget).toBe(200_000 / PRICE);
		// The open reservation holds that $0.20: the next begin finds the trial spent.
		const r = await begin(p, projectId);
		expect(r.outcome).toBe('trial');
		const [w] = await asOwner(
			`SELECT extract(epoch FROM s.trial_end - now())::int AS s FROM subscription s JOIN billing_account a ON a.id = s.billing_account_id WHERE a.user_id = $1 AND s.status = 'trialing'`,
			[p.id]
		);
		expect(Math.abs(r.wait_seconds - Number(w!.s))).toBeLessThanOrEqual(2);
	});

	it('never refuses with billing enforcement off', async () => {
		const { p, projectId, account } = await trialist();
		await dayRow(p, account, await sastDay(), 10_000_000);
		vi.stubEnv('BILLING_ENFORCED', 'false');
		const r = await begin(p, projectId);
		expect(r.outcome).toBe('ok');
		expect(r.budget).toBe(MAX);
	});

	it('draws on the Free pool: the trial’s spend is in the pool’s month and a spent pool refuses it', async () => {
		const { p, projectId, account } = await trialist();
		await dayRow(p, account, await sastDay(), 400_000);
		await asOwner(
			`INSERT INTO assistant_usage (project_id, user_id, month, cost_usd_micros) VALUES ($1, $2, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 400000)`,
			[projectId, p.id]
		);
		const r = await begin(p, projectId);
		expect(r.outcome).toBe('ok');
		expect(r.pool).toBe(1e15);
		expect(r.pool_used).toBeGreaterThanOrEqual(400_000);
		await asOwner('DELETE FROM assistant_reservation WHERE project_id = $1', [projectId]);
		expect((await begin(p, projectId, 1)).outcome).toBe('pool');
	});
});
