// The day the operator switches BILLING_ENFORCED on, rehearsed over existing-user data (round 2026-11-28; docs/billing.md
// § BILLING_ENFORCED, docs/deployment.md § Turning on enforcement). Seeded in shadow mode, as production stands today:
//  - an account that never paid, past Free's one live catchment (from before enforcement);
//  - a staff grant that ended in shadow mode, past Free's live catchments, its owner reading Afrikaans;
//  - a reverse trial that lapsed in shadow mode, past Free's live catchments;
//  - a staff grant still live, past Free's live catchments (positive control: never refused);
//  - a team over its paid editor seats since before 403/404 wrote the marker;
//  - an unverified Free person with a live feed and assistant use.
// Then enforcement goes on (the `app.billing_enforced` setting, as db/tx.ts sets it from BILLING_ENFORCED) and the
// worker's tick runs. What the runbook promises: nothing pauses before its 14-day grace; the grace email goes once per
// account, in its owner's language; every refusal is one the plan page (or the workspace note beside the switch)
// explains; the over-seats team can't add editors but keeps its access; and the billing report says, before and after
// the switch, who will pause and when.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, disableFeedsAfterFile, lastMailTo, mailCount, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { cellCentre } from '../feeds/cellCache.js';
import { runTick } from '../jobs/runner.js';
import { PLAN_NOTICES_PER_TICK, runPlanNotices } from './planNotices.js';
import { gatherReport } from '../../scripts/billing-report.js';
import { formatReport, type Report } from './metrics.js';

type Person = Awaited<ReturnType<typeof signUp>> & { email: string };

const alertBody = { rules: [{ kind: 'ewr_forecast_fail', threshold: 5, enabled: true }] };
const feedBody = { source: 'chirps', enabled: true, config: { cells: [{ ...cellCentre({ row: 1600, col: 4100 }), weight: 1 }], startDate: '2024-01-01' } };
const made: string[] = [];
const tick = () => runTick({ feeds: false, reports: false, alerts: false, maxJobs: 0 });
const report = () => gatherReport(process.env.TEST_MIGRATION_DATABASE_URL!, null, new Date());
const pausesOf = (r: Report, account: string) => r.planPauses.find((p) => p.accountId === account);

async function person(name: string, opts?: { verified?: boolean }): Promise<Person> {
	const p = await signUp(name, opts);
	const [u] = await asOwner('SELECT email FROM app_user WHERE id = $1', [p.id]);
	return Object.assign(p, { email: u.email as string });
}
async function liveProject(p: Person, name: string, teamId?: string): Promise<string> {
	const res = await p.call('POST', '/projects', teamId ? { name, teamId } : { name });
	expect(res.status).toBe(201);
	const id = res.body.project.id as string;
	made.push(id);
	// An alert rule makes it live (338).
	expect((await p.call('PUT', `/projects/${id}/alert-rules`, alertBody)).status).toBe(200);
	return id;
}
const accountOf = async (pid: string) => ((await asOwner('SELECT billing_account_id AS a FROM project WHERE id = $1', [pid])) as { a: string }[])[0]!.a;
const pausedIn = async (ids: string[]) =>
	((await asOwner('SELECT project_id AS id FROM project_plan_pause WHERE project_id = ANY($1::uuid[]) ORDER BY 1', [ids])) as { id: string }[]).map((r) => r.id);
const graceOf = async (account: string) =>
	((await asOwner('SELECT over_free_since AS t FROM billing_account WHERE id = $1', [account])) as { t: Date | null }[])[0]!.t;
const notices = async (account: string) =>
	(await asOwner('SELECT kind, status FROM billing_notice WHERE billing_account_id = $1 ORDER BY created_at, kind', [account])) as { kind: string; status: string }[];

disableFeedsAfterFile();
afterAll(async () => {
	vi.unstubAllEnvs();
	await retirePendingJobs(...made);
});

describe('turning BILLING_ENFORCED on over existing users', () => {
	let legacy: Person; // never paid, two live catchments
	let granted: Person; // a staff grant that ended in shadow mode, three live catchments, Afrikaans
	let trialist: Person; // a reverse trial that lapsed in shadow mode, two live catchments
	let pilot: Person; // a staff grant still live, two live catchments
	let admin: Person; // a team over its paid seats
	let teamMembers: Person[];
	let teamViewer: Person;
	let unverified: Person; // Free, unverified, a feed on and assistant use
	const p: Record<string, string[]> = {};
	const acct: Record<string, string> = {};
	let teamId: string;
	let teamProject: string;
	let feedId: string;

	beforeAll(async () => {
		vi.stubEnv('BILLING_ENFORCED', 'false');
		legacy = await person('TurnOnLegacy');
		granted = await person('TurnOnGranted');
		trialist = await person('TurnOnTrialist');
		pilot = await person('TurnOnPilot');
		admin = await person('TurnOnTeamAdmin');
		teamMembers = await Promise.all(['TurnOnM1', 'TurnOnM2', 'TurnOnM3'].map((n) => person(n)));
		teamViewer = await person('TurnOnViewer');
		unverified = await person('TurnOnUnverified', { verified: false });

		p.legacy = [await liveProject(legacy, 'Legacy Alpha'), await liveProject(legacy, 'Legacy Bravo')];
		p.granted = [await liveProject(granted, 'Grant Alpha'), await liveProject(granted, 'Grant Bravo'), await liveProject(granted, 'Grant Charlie')];
		p.trialist = [await liveProject(trialist, 'Trial Alpha'), await liveProject(trialist, 'Trial Bravo')];
		p.pilot = [await liveProject(pilot, 'Pilot Alpha'), await liveProject(pilot, 'Pilot Bravo')];
		for (const k of ['legacy', 'granted', 'trialist', 'pilot']) acct[k] = await accountOf(p[k]![0]!);
		await asOwner(`UPDATE app_user SET locale = 'af' WHERE id = $1`, [granted.id]);

		// A staff grant whose end passed in shadow mode (the tick expires it, enforced or not).
		await asOwner(
			`INSERT INTO subscription (billing_account_id, plan_code, status, period_start, period_end, provider)
			 VALUES ($1, 'pro', 'active', now() - interval '60 days', now() - interval '1 hour', 'manual')`,
			[acct.granted]
		);
		// A reverse trial as 342 writes it, its end gone in shadow mode.
		await asOwner(
			`INSERT INTO subscription (billing_account_id, plan_code, status, period_start, period_end, trial_end, cancel_at_period_end, provider)
			 VALUES ($1, 'pro', 'trialing', now() - interval '15 days', now() - interval '1 hour', now() - interval '1 hour', true, 'manual')`,
			[acct.trialist]
		);
		// A staff grant still running.
		await asOwner(
			`INSERT INTO subscription (billing_account_id, plan_code, status, period_start, period_end, provider)
			 VALUES ($1, 'pro', 'active', now() - interval '1 day', now() + interval '60 days', 'manual')`,
			[acct.pilot]
		);

		// A team on 3 paid seats with 4 editors (the admin and three members) and a viewer.
		teamId = (await admin.call('POST', '/teams', { name: `Turn on ${crypto.randomUUID().slice(0, 8)}` })).body.team.id as string;
		acct.team = ((await asOwner(`SELECT billing_account_ensure('team', $1) AS id`, [teamId])) as { id: string }[])[0]!.id;
		await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, seats, provider) VALUES ($1, 'team', 'active', 3, 'mock')`, [acct.team]);
		for (const m of teamMembers) await asOwner(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, m.id]);
		await asOwner(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'viewer')`, [teamId, teamViewer.id]);
		// Over since before 403/404 wrote the marker: existing data carries none.
		await asOwner('UPDATE billing_account SET over_seats_since = NULL WHERE id = $1', [acct.team]);
		const tp = await admin.call('POST', '/projects', { name: 'Team catchment', teamId });
		expect(tp.status).toBe(201);
		teamProject = tp.body.project.id as string;
		made.push(teamProject);

		// The unverified person: a feed switched on in shadow mode and a month of assistant use.
		const up = await unverified.call('POST', '/projects', { name: 'Unverified farm' });
		expect(up.status).toBe(201);
		p.unverified = [up.body.project.id as string];
		made.push(p.unverified[0]!);
		acct.unverified = await accountOf(p.unverified[0]!);
		const f = await unverified.call('POST', `/projects/${p.unverified[0]}/feeds`, feedBody);
		expect(f.status).toBe(201);
		feedId = f.body.feed.id as string;
		await asOwner(
			`INSERT INTO assistant_usage (project_id, user_id, month, cost_usd_micros) VALUES ($1, $2, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 400000)`,
			[p.unverified[0], unverified.id]
		);

		// The last shadow tick before the switch: it expires the grant and the trial, and starts no grace (409).
		await tick();
	});

	it('before the switch, the report says who will pause once it is on, and the team over its seats', async () => {
		expect(await graceOf(acct.granted!)).toBeNull();
		expect(await graceOf(acct.trialist!)).toBeNull();
		const r = await report();
		expect(pausesOf(r, acct.granted!)).toMatchObject({ state: 'grace_at_switch', live: 3, limit: 1, overFreeSince: null, pausesFrom: null, paused: 0 });
		expect(pausesOf(r, acct.trialist!)).toMatchObject({ state: 'grace_at_switch', live: 2 });
		expect(pausesOf(r, acct.legacy!)).toMatchObject({ state: 'never_paid', live: 2 });
		// A live plan is never listed (positive control: the same live count on a lapsed plan is).
		expect(pausesOf(r, acct.pilot!)).toBeUndefined();
		// The team went over before any marker: still listed, its since unrecorded.
		expect(r.overSeats.find((o) => o.accountId === acct.team)).toMatchObject({ teamId, seats: 3, editors: 4, since: null });
		const text = formatReport(r, false);
		expect(text).toContain(`account ${acct.granted}  user  3 live of 1  plan ended, no grace yet: the 14 days and the grace email start at the first enforced tick, then 2 pause`);
		expect(text).toContain(`account ${acct.legacy}  user  2 live of 1  never had a plan: nothing pauses`);
		expect(text).toContain(`team ${teamId}  4 editors on 3 seats  since before it was recorded (no marker)`);
		// Nothing emailed in shadow mode.
		expect(await notices(acct.granted!)).toEqual([]);
	});

	it('the first enforced tick starts each grace, emails each owner once in their language, and pauses nothing', async () => {
		vi.stubEnv('BILLING_ENFORCED', 'true');
		const before = { granted: mailCount(granted.email), trialist: mailCount(trialist.email), legacy: mailCount(legacy.email), pilot: mailCount(pilot.email) };
		await tick();
		const all = Object.values(p).flat();
		expect(await pausedIn(all)).toEqual([]);
		expect(await graceOf(acct.granted!)).not.toBeNull();
		expect(await graceOf(acct.trialist!)).not.toBeNull();
		// Never paid, or on a live plan: no grace.
		expect(await graceOf(acct.legacy!)).toBeNull();
		expect(await graceOf(acct.pilot!)).toBeNull();

		expect(mailCount(granted.email)).toBe(before.granted + 1);
		const af = lastMailTo(granted.email)!;
		expect(af.kind).toBe('plan_notice');
		expect(af.html).toContain('<html lang="af">');
		expect(af.subject).not.toContain('automatic updates pause');
		expect(mailCount(trialist.email)).toBe(before.trialist + 1);
		const en = lastMailTo(trialist.email)!;
		expect(en.html).toContain('<html lang="en">');
		expect(en.subject).toMatch(/^Some catchments’ automatic updates pause on /);
		expect(mailCount(legacy.email)).toBe(before.legacy);
		expect(mailCount(pilot.email)).toBe(before.pilot);

		// Once per account: a second tick sends nothing.
		await tick();
		expect(mailCount(granted.email)).toBe(before.granted + 1);
		expect(mailCount(trialist.email)).toBe(before.trialist + 1);
		expect(await notices(acct.granted!)).toEqual([{ kind: 'grace', status: 'sent' }]);
		expect(await notices(acct.trialist!)).toEqual([{ kind: 'grace', status: 'sent' }]);
	});

	it('the report then shows each pause date, 14 days from the switch', async () => {
		const r = await report();
		const g = pausesOf(r, acct.granted!)!;
		const since = (await graceOf(acct.granted!))!;
		expect(g).toMatchObject({ state: 'grace', overFreeSince: since.toISOString(), paused: 0 });
		expect(Date.parse(g.pausesFrom!) - since.getTime()).toBe(14 * 86_400_000);
		expect(formatReport(r, false)).toContain(`in its grace since ${since.toISOString()}, pauses 2 from ${g.pausesFrom}`);
	});

	it('every refusal is one the plan page explains; live catchments, seats and access are kept', async () => {
		// The never-paid account: no third live catchment, its two live ones untouched and still editable.
		const third = await legacy.call('POST', '/projects', { name: 'Legacy Charlie' });
		made.push(third.body.project.id as string);
		const refused = await legacy.call('PUT', `/projects/${third.body.project.id}/alert-rules`, alertBody);
		expect(refused.status).toBe(402);
		// `used` is what the change would need: the plan page's 2 live and this one.
		expect(refused.body).toMatchObject({ code: 'plan_limit', params: { key: 'live_catchments', limit: 1, used: 3, plan: 'free' } });
		expect((await legacy.call('PUT', `/projects/${p.legacy![0]}/alert-rules`, alertBody)).status).toBe(200);
		const legacyPlan = (await legacy.call('GET', '/account/plan')).body;
		expect(legacyPlan.enforced).toBe(true);
		expect(legacyPlan.usage.liveCatchments).toEqual({ used: 2, limit: 1 });

		// The lapsed grant's plan page: the grace dates, every catchment still live.
		const list = (await granted.call('GET', '/account/plan/live-catchments')).body;
		expect(list).toMatchObject({ planEnded: true });
		expect(Date.parse(list.pausesFrom) - Date.parse(list.overFreeSince)).toBe(14 * 86_400_000);

		// The live staff grant: a third live catchment is not refused (positive control).
		const pilotThird = await liveProject(pilot, 'Pilot Charlie');
		expect(pilotThird).toBeTruthy();

		// The team: a viewer made an editor is refused with the seat numbers its plan page shows; every member keeps access.
		const add = await admin.call('PATCH', `/teams/${teamId}/members/${teamViewer.id}`, { role: 'member' });
		expect(add.status).toBe(402);
		// `used` is what the change would need (api.md § Billing): the plan page's 4 editors and this one.
		expect(add.body).toMatchObject({ code: 'plan_limit', params: { limit: 3, used: 5, plan: 'team' } });
		const teamPlan = (await admin.call('GET', `/teams/${teamId}/plan`)).body;
		expect(teamPlan.enforced).toBe(true);
		expect(teamPlan.team.overSeats).toMatchObject({ seats: 3, editors: 4 });
		for (const m of [...teamMembers, teamViewer]) expect((await m.call('GET', `/projects/${teamProject}`)).status).toBe(200);

		// The unverified person: the feed already on stays on and saves; a new feed and the assistant are refused with
		// the codes the workspace notes word (EmailGateNotice), and the plan page says limits are enforced.
		const [feed] = (await asOwner('SELECT enabled FROM data_feed WHERE id = $1', [feedId])) as { enabled: boolean }[];
		expect(feed?.enabled).toBe(true);
		expect((await unverified.call('PATCH', `/projects/${p.unverified![0]}/feeds/${feedId}`, { enabled: true })).status).toBe(200);
		const newFeed = await unverified.call('POST', `/projects/${p.unverified![0]}/feeds`, feedBody);
		expect(newFeed.status).toBe(403);
		expect(newFeed.body.code).toBe('email_unverified');
		vi.stubEnv('ASSISTANT_PROVIDER', 'mock');
		const turn = await unverified.call('POST', `/projects/${p.unverified![0]}/assistant/messages`, { messages: [{ role: 'user', content: 'Hello' }] });
		expect(turn.status).toBe(403);
		expect(turn.body.code).toBe('email_unverified');
		const uPlan = (await unverified.call('GET', '/account/plan')).body;
		expect(uPlan.enforced).toBe(true);
		expect(uPlan.usage.liveCatchments).toEqual({ used: 1, limit: 1 });
	});

	it('nothing pauses a minute before the 14 days; the pause lands after them, with its own email, once', async () => {
		await asOwner(`UPDATE billing_account SET over_free_since = now() - interval '14 days' + interval '1 minute' WHERE id = $1`, [acct.granted]);
		await tick();
		expect(await pausedIn(p.granted!)).toEqual([]);
		const before = mailCount(granted.email);
		await asOwner(`UPDATE billing_account SET over_free_since = now() - interval '14 days' - interval '1 minute' WHERE id = $1`, [acct.granted]);
		await tick();
		expect((await pausedIn(p.granted!)).length).toBe(2);
		expect(mailCount(granted.email)).toBe(before + 1);
		await tick();
		expect(mailCount(granted.email)).toBe(before + 1);
		const r = await report();
		expect(pausesOf(r, acct.granted!)).toMatchObject({ state: 'paused', paused: 2, live: 3 });
		// The other accounts: still in their grace, never paid, or on a plan, nothing paused.
		expect(await pausedIn([...p.trialist!, ...p.legacy!, ...p.pilot!])).toEqual([]);
	});
});

describe('the first enforced tick’s email volume: capped per tick, the rest drain on later ticks', () => {
	it('sends at most the cap each tick, keeps the rest pending in order, and sends each once', async () => {
		expect(PLAN_NOTICES_PER_TICK).toBe(100);
		// Seeded in shadow mode, as the accounts stood before the switch.
		vi.stubEnv('BILLING_ENFORCED', 'false');
		const owners: Person[] = [];
		const accounts: string[] = [];
		for (const n of ['DrainA', 'DrainB', 'DrainC']) {
			const o = await person(`TurnOn${n}`);
			const ids = [await liveProject(o, `${n} Alpha`), await liveProject(o, `${n} Bravo`)];
			const a = await accountOf(ids[0]!);
			await asOwner(`INSERT INTO subscription (billing_account_id, plan_code, status, provider) VALUES ($1, 'pro', 'canceled', 'mock')`, [a]);
			// The grace started at the switch (what the enforced pause sweep stamps).
			await asOwner('UPDATE billing_account SET over_free_since = now() WHERE id = $1', [a]);
			owners.push(o);
			accounts.push(a);
		}
		const mine = async () =>
			(await asOwner(`SELECT status FROM billing_notice WHERE billing_account_id = ANY($1::uuid[]) AND kind = 'grace'`, [accounts])) as { status: string }[];
		const before = owners.map((o) => mailCount(o.email));
		vi.stubEnv('BILLING_ENFORCED', 'true');
		// A cap of 2 stands in for 100 over three accounts.
		const first = await runPlanNotices({ limit: 2 });
		expect(first.queued).toBeGreaterThanOrEqual(3);
		expect(first.sent + first.skipped + first.failed).toBeLessThanOrEqual(2);
		expect((await mine()).filter((r) => r.status === 'pending').length).toBeGreaterThanOrEqual(1);
		for (let i = 0; i < 10 && (await mine()).some((r) => r.status !== 'sent'); i++) {
			const r = await runPlanNotices({ limit: 2 });
			expect(r.sent + r.skipped + r.failed).toBeLessThanOrEqual(2);
		}
		expect((await mine()).map((r) => r.status)).toEqual(['sent', 'sent', 'sent']);
		for (const [i, o] of owners.entries()) {
			expect(mailCount(o.email)).toBe(before[i]! + 1);
			expect(lastMailTo(o.email)!.kind).toBe('plan_notice');
		}
		await asOwner(`UPDATE billing_account SET over_free_since = NULL WHERE id = ANY($1::uuid[])`, [accounts]);
	});
});
