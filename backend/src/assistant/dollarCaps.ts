// The assistant's dollar caps and the paced Free pool (issue #641;
// 336_assistant_dollar_caps.sql, 337_assistant_sast_day.sql, 342_reverse_trial.sql (the trial's caps), docs/billing.md §
// Assistant dollar caps). app_assistant_begin decides; this module holds the
// sums the backend shows or logs beside it, and the refusals' wording. The Free
// day is the South African day (00:00 SAST, 22:00 UTC; 337); every month is
// UTC, as assistant_usage's.
import type { ErrorCode } from '../http/errors.js';

const DAY_MS = 86_400_000;

/** SAST is UTC+2 all year (Africa/Johannesburg has had no daylight saving since 1944). */
const SAST_OFFSET_MS = 2 * 3_600_000;

/** The SAST day `now` falls on, as a Date at that day's 00:00 UTC (SQL's assistant_day_of). */
export function sastDay(now: Date): Date {
	const local = new Date(now.getTime() + SAST_OFFSET_MS);
	return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

/**
 * SAST days left in `now`'s UTC month, `now`'s SAST day included, at least 1.
 * Between 22:00 and 24:00 UTC on a month's last day the SAST day is already the
 * next month's first, so none is left: 1.
 */
export function daysLeftInMonth(now: Date): number {
	const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
	return Math.max(1, Math.round((monthEnd - sastDay(now).getTime()) / DAY_MS));
}

/**
 * The Free pool's share for the SAST day `now` falls on: (pool left at the
 * day's start ÷ days left in the UTC month, the day included) × 2, in whole
 * micro-USD, never below 0. The same sum as SQL's assistant_pool_day_allowance
 * (a DB test pins them together).
 */
export function poolDayAllowance(poolUsdMicros: number, spentBeforeTodayUsdMicros: number, now: Date): number {
	const left = Math.max(0, poolUsdMicros - spentBeforeTodayUsdMicros);
	return Math.max(0, Math.floor((left / daysLeftInMonth(now)) * 2));
}

/** The pool's alarm thresholds, in percent of the month's pool (infra/alarms.tf). */
export const POOL_ALARM_SHARES = [50, 80] as const;

/**
 * The highest alarm threshold the pool's month has passed (50 or 80), or null
 * below 50% or with no pool. Logged as `assistant_free_pool` on each begun turn
 * of a pool account, which the alarms count.
 */
export function poolAlarmShare(usedUsdMicros: number | null, poolUsdMicros: number | null): 50 | 80 | null {
	if (usedUsdMicros === null || !poolUsdMicros) return null;
	const pct = (usedUsdMicros / poolUsdMicros) * 100;
	return pct >= 80 ? 80 : pct >= 50 ? 50 : null;
}

/** The next 00:00 SAST after `now` (22:00 UTC), ISO: when the Free day starts again. */
export function dayResetsAt(now = new Date()): string {
	return new Date(sastDay(now).getTime() + DAY_MS - SAST_OFFSET_MS).toISOString();
}

/**
 * The reverse trial's assistant caps in micro-USD (issue #641 "AI during the trial: Sonnet, $2 in all, $1 a day";
 * 342_reverse_trial.sql assistant_trial_caps, which a DB test pins to these): over the whole trial, and a SAST day.
 */
export const TRIAL_CAPS = { totalUsdMicros: 2_000_000, dayUsdMicros: 1_000_000 } as const;

/** app_assistant_begin's dollar outcomes ('trial', 'trial_day': a reverse trial's own caps, 342). */
export type DollarOutcome = 'day' | 'trial' | 'trial_day' | 'month' | 'member' | 'pool';

export const isDollarOutcome = (o: string): o is DollarOutcome => Object.hasOwn(DOLLAR_REFUSAL, o);

/** Each dollar refusal's stable code (http/errors.ts ERROR_CODES) and the issue's words (#641 "Copy"; workspace, English). */

export const DOLLAR_REFUSAL: Record<DollarOutcome, { code: ErrorCode; message: (resetsAt: string, nowMs?: number) => string }> = {
	day: {
		code: 'assistant_daily_cap',
		message: () =>
			'That’s today’s free assistant use. It’s back at midnight, South African time. Everything else in your catchment keeps working: runs, calibration, scenarios and exports have no limit on Free.'
	},
	trial: {
		code: 'assistant_trial_cap',
		message: (resetsAt) =>
			`You’ve used the assistant allowance that comes with your trial. The free assistant is back on ${longDate(resetsAt)}, when your trial ends. Everything else in your catchment keeps working.`
	},
	trial_day: {
		code: 'assistant_trial_daily_cap',
		message: () =>
			'That’s today’s assistant use on your trial. It’s back at midnight, South African time. Everything else in your catchment keeps working.'
	},
	month: {
		code: 'assistant_monthly_cap',
		message: (resetsAt) =>
			`You’ve used this month’s assistant allowance. It’s back on ${longDate(resetsAt)}. Your models, runs and exports aren’t affected.`
	},
	member: {
		code: 'assistant_member_cap',
		message: (resetsAt) =>
			`You’ve used your share of your team’s assistant allowance this month. It’s back on ${longDate(resetsAt)}; a team admin can raise your share. Your models, runs and exports aren’t affected.`
	},
	pool: {
		code: 'assistant_free_pool_spent',
		// The day's paced share is back at the next 00:00 SAST; when the month's whole pool is gone it is back at the
		// month's start, which can be weeks away, so that case names the date rather than saying "tomorrow".
		message: (resetsAt, nowMs = Date.now()) =>
			Date.parse(resetsAt) - nowMs > DAY_MS
				? `The free assistant has reached its shared limit for this month. It’s back on ${longDate(resetsAt)}. This isn’t something you did, and your work isn’t affected.`
				: 'The free assistant has reached its shared limit for today. It’s back tomorrow. This isn’t something you did, and your work isn’t affected.'
	}
};

/** "1 December", from an ISO instant (UTC). */
function longDate(iso: string): string {
	const d = new Date(iso);
	return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })}`;
}
