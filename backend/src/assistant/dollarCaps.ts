// The assistant's dollar caps and the paced Free pool (issue #641;
// 336_assistant_dollar_caps.sql, docs/billing.md § Assistant dollar caps).
// app_assistant_begin decides; this module holds the sums the backend shows
// or logs beside it, and the refusals' wording. Every boundary is UTC.
import type { ErrorCode } from '../http/errors.js';

/** Days left in `day`'s UTC month, `day` included (1 on the last day). */
export function daysLeftInMonth(day: Date): number {
	const last = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
	return last - day.getUTCDate() + 1;
}

/**
 * The Free pool's share for a UTC day: (pool left at the day's start ÷ days
 * left, the day included) × 2, in whole micro-USD, never below 0. The same sum
 * as SQL's assistant_pool_day_allowance (a DB test pins them together).
 */
export function poolDayAllowance(poolUsdMicros: number, spentBeforeTodayUsdMicros: number, day: Date): number {
	const left = Math.max(0, poolUsdMicros - spentBeforeTodayUsdMicros);
	return Math.max(0, Math.floor((left / daysLeftInMonth(day)) * 2));
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

/** When the UTC day after `now` starts, ISO. */
export function dayResetsAt(now = new Date()): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

/** app_assistant_begin's dollar outcomes. */
export type DollarOutcome = 'day' | 'month' | 'member' | 'pool';

/** Each dollar refusal's stable code (http/errors.ts ERROR_CODES) and the issue's words (#641 "Copy"; workspace, English). */
export const DOLLAR_REFUSAL: Record<DollarOutcome, { code: ErrorCode; message: (resetsAt: string) => string }> = {
	day: {
		code: 'assistant_daily_cap',
		message: () =>
			'That’s today’s free assistant use. It’s back at midnight (UTC). Everything else in your catchment keeps working: runs, calibration, scenarios and exports have no limit on Free.'
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
		message: () => 'The free assistant has reached its shared limit for today. It’s back tomorrow. This isn’t something you did, and your work isn’t affected.'
	}
};

/** "1 December", from an ISO instant (UTC). */
function longDate(iso: string): string {
	const d = new Date(iso);
	return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })}`;
}
