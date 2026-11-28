// runTick's billing sweeps never stop the tick (jobs/runner.ts billingStep): a sweep that throws is logged as
// billing_tick_step_failed with its step and SQLSTATE only, recorded in billingFailed, and the feeds, alerts, jobs and
// plan emails after it still run. Positive control: with every sweep working, billingFailed is empty and the counts
// come through. Every module the tick reaches is mocked: no database.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const failing = new Set<string>();
const sqlSeen: string[] = [];
const db = {
	query: vi.fn(async (sql: string) => {
		sqlSeen.push(sql);
		for (const fn of failing) {
			if (sql.includes(fn)) {
				// A pg error whose message carries a row value: it must never reach the log.
				throw Object.assign(new Error('duplicate key value (owner@example.com)'), { code: '40P01' });
			}
		}
		return { rows: [{ n: sql.includes('app_plan_pause_tick') ? 2 : 0 }] };
	})
};
vi.mock('../db/tx.js', () => ({
	withoutUser: (fn: (d: typeof db) => Promise<unknown>) => fn(db),
	withUser: (_u: string, fn: (d: typeof db) => Promise<unknown>) => fn(db)
}));
const logged: Record<string, unknown>[] = [];
vi.mock('../logging/logEvent.js', () => ({ logEvent: (_level: string, fields: Record<string, unknown>) => logged.push(fields) }));

const claimJobs = vi.fn(async () => []);
vi.mock('./queue.js', () => ({
	claimJobs: () => claimJobs(),
	finishJob: vi.fn(),
	finishJobOutcome: vi.fn(),
	nextJobDueSeconds: vi.fn(async () => null),
	purgeJobs: vi.fn(async () => 0),
	queueStats: vi.fn(async () => ({ due: 0, running: 0, oldestDueSeconds: 0 }))
}));
vi.mock('./handlers/index.js', () => ({ handlers: {} }));
vi.mock('../invites/invites.js', () => ({ purgeInvites: vi.fn(async () => 0) }));
const sendErratumNotices = vi.fn(async () => ({ sent: 0, skipped: 0, failed: 0 }));
vi.mock('../errata/notices.js', () => ({
	purgeErratumNotices: vi.fn(async () => 0),
	sendErratumNotices: () => sendErratumNotices(),
	sweepErrata: vi.fn(async () => 0)
}));
vi.mock('../evidence/notices.js', () => ({ purgePackNotices: vi.fn(async () => 0), sendPackNotices: vi.fn(async () => ({ sent: 0, skipped: 0, failed: 0 })) }));
const scheduleDueFeeds = vi.fn(async () => ({ queued: 1 }));
vi.mock('../feeds/schedule.js', () => ({ scheduleDueFeeds: () => scheduleDueFeeds() }));
const sendAlerts = vi.fn(async () => ({ sent: 3, skipped: 0, failed: 0, digests: 0 }));
vi.mock('../alerts/send.js', () => ({ sendAlerts: () => sendAlerts() }));
vi.mock('../licence/record.js', () => ({ sendLicenceRecordNotices: vi.fn(async () => ({ due: 0, sent: 0, skipped: 0, failed: 0 })) }));
vi.mock('../reports/erasure.js', () => ({ erasePendingReportPdfs: vi.fn(async () => ({ erased: 0, failed: 0 })) }));
vi.mock('../reports/schedule.js', () => ({ purgeReports: vi.fn(async () => 0), scheduleDueReports: vi.fn(async () => ({ queued: 0 })) }));
vi.mock('../auth/mfaReset.js', () => ({ runMfaResets: vi.fn(async () => ({ completed: 0, reminded: 0, purged: 0, failed: 0 })) }));
const runPlanNotices = vi.fn(async () => ({ queued: 1, sent: 1, skipped: 0, failed: 0 }));
vi.mock('../billing/planNotices.js', () => ({ runPlanNotices: () => runPlanNotices() }));
vi.mock('../billing/renewal.js', () => ({ runRenewalNotices: vi.fn(async () => ({ queued: 0, sent: 0, skipped: 0, failed: 0 })) }));
const runMirrorTick = vi.fn(async () => null);
vi.mock('./handlers/mirror-tick.js', () => ({ runMirrorTick: () => runMirrorTick() }));
vi.mock('../feeds/gaugeRecordLoad.js', () => ({ runDwsTick: vi.fn(async () => null) }));
vi.mock('../dams/observed/tick.js', () => ({ runDamsTick: vi.fn(async () => null) }));
vi.mock('../water-use/observed/tick.js', () => ({ runEtTick: vi.fn(async () => null) }));

const { envInt, runTick } = await import('./runner.js');

beforeEach(() => {
	failing.clear();
	sqlSeen.length = 0;
	logged.length = 0;
	vi.clearAllMocks();
});

describe('runTick: the billing sweeps', () => {
	it('all working (positive control): nothing failed, the counts come through', async () => {
		const r = await runTick({ maxJobs: 1 });
		expect(r.billingFailed).toEqual([]);
		expect(r.catchmentsPaused).toBe(2);
		expect(logged.filter((f) => f.event === 'billing_tick_step_failed')).toEqual([]);
	});

	it('a sweep that throws is logged and recorded, and the rest of the tick still runs', async () => {
		failing.add('app_plan_pause_tick');
		failing.add('app_staff_grant_expire');
		const r = await runTick({ maxJobs: 1 });
		expect(r.billingFailed).toEqual(['staff_grant_expire', 'plan_pause']);
		expect(r.catchmentsPaused).toBe(0);
		// The sweeps between and after them ran.
		for (const fn of ['app_reverse_trial_expire', 'app_billing_dunning_lapse', 'app_report_usage_refund_silent', 'app_alert_schedule'])
			expect(sqlSeen.some((s) => s.includes(fn)), fn).toBe(true);
		// Feeds scheduled, jobs claimed, alerts and plan emails sent.
		expect(runMirrorTick).toHaveBeenCalledOnce();
		expect(scheduleDueFeeds).toHaveBeenCalledOnce();
		expect(r.feeds).toEqual({ queued: 1 });
		expect(claimJobs).toHaveBeenCalled();
		expect(sendAlerts).toHaveBeenCalledOnce();
		expect(r.alerts.sent).toBe(3);
		expect(sendErratumNotices).toHaveBeenCalledOnce();
		expect(runPlanNotices).toHaveBeenCalledOnce();
		expect(r.planNotices.sent).toBe(1);
		// A stable key, the step and the SQLSTATE; never the message, which can carry a row's values.
		const events = logged.filter((f) => f.event === 'billing_tick_step_failed');
		expect(events.map((f) => f.step)).toEqual(['staff_grant_expire', 'plan_pause']);
		expect(events[0]).toMatchObject({ code: '40P01' });
		expect(JSON.stringify(events)).not.toContain('example.com');
	});
});

describe('runTick: every billing sweep is caught under its own name', () => {
	it('all five failing: each recorded once, in the order they run, every count 0, and the tick still sends', async () => {
		for (const fn of ['app_staff_grant_expire', 'app_reverse_trial_expire', 'app_billing_dunning_lapse', 'app_report_usage_refund_silent', 'app_plan_pause_tick'])
			failing.add(fn);
		const r = await runTick({ maxJobs: 1 });
		expect(r.billingFailed).toEqual(['staff_grant_expire', 'reverse_trial_expire', 'dunning_lapse', 'report_refund', 'plan_pause']);
		expect([r.staffGrantsExpired, r.reverseTrialsExpired, r.subscriptionsLapsed, r.reportsRefunded, r.catchmentsPaused]).toEqual([0, 0, 0, 0, 0]);
		expect(sendAlerts).toHaveBeenCalledOnce();
		expect(runPlanNotices).toHaveBeenCalledOnce();
		expect(logged.filter((f) => f.event === 'billing_tick_step_failed')).toHaveLength(5);
	});
});

describe('envInt (JOB_MAX_PER_TICK, JOB_LEASE_SECONDS, JOB_POLL_SECONDS)', () => {
	it('takes a positive whole number, spaces round it allowed', () => {
		expect(envInt('7', 25)).toBe(7);
		expect(envInt(' 30 ', 25)).toBe(30);
		expect(envInt('1', 25)).toBe(1);
	});

	it('falls back on unset, blank, zero, negative, fractional or non-numeric: never a lease of 0 or a tick that claims nothing', () => {
		for (const v of [undefined, '', '  ', '0', '-5', '2.5', 'ten', 'NaN', 'Infinity']) expect(envInt(v, 25), String(v)).toBe(25);
	});
});

