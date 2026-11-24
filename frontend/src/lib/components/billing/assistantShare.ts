// The team plan page's "Assistant share" control (issue #641 "One person may
// use at most 50% unless a team admin raises it", docs/ui.md § Plan and usage;
// AssistantShare.svelte): pure helpers, so the component only lays them out.
// The share is billing_account.assistant_member_max_pct (336), set by POST
// /teams/:id/plan/assistant-share (339), and binds only on a per-seat plan
// (Team), where the month's assistant dollars are pooled. English: the
// workspace is.
import type { AccountPlan } from '#lib/api/types.js';
import { fmtUsdMicros } from './plan';

export const SHARE_MIN = 1;
export const SHARE_MAX = 100;

export interface AssistantShareState {
	/** The share now, in whole percent. */
	current: number;
	/** Whether the plan pools the month per seat (Team), where the share binds. */
	pooled: boolean;
	/** The month's pooled assistant dollars (micro-USD) when the plan says them; null otherwise. */
	monthUsdMicros: number | null;
}

/** What the control needs; null on a person's account or a plan read from before 339 (no share in it). */
export function assistantShareState(p: AccountPlan): AssistantShareState | null {
	if (p.account.kind !== 'team' || !p.team) return null;
	const pct = (p.team as { assistantMemberMaxPct?: unknown }).assistantMemberMaxPct;
	if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < SHARE_MIN || pct > SHARE_MAX) return null;
	const pooled = typeof p.plan.limits?.assistant_usd_micros_per_seat_month === 'number';
	const limit = p.usage?.assistantCost?.limitUsdMicros;
	return { current: pct, pooled, monthUsdMicros: pooled && typeof limit === 'number' ? limit : null };
}

/** The dollars `pct` of the pooled month is, as the database works it out (336: limit × pct ÷ 100, rounded down). */
export function shareUsdMicros(monthUsdMicros: number, pct: number): number {
	return Math.floor((monthUsdMicros * pct) / 100);
}

/**
 * The line under the control: "One member may use up to 50% of the team's
 * assistant dollars a month ($22.50 of $45.00)." 100% says there is no
 * per-member limit; off a per-seat plan it says the share applies on Team.
 */
export function assistantShareLine(st: AssistantShareState): string {
	const head =
		st.current === SHARE_MAX
			? 'Any one member may use all of the team’s assistant dollars a month'
			: `One member may use up to ${st.current}% of the team’s assistant dollars a month`;
	if (!st.pooled) return `${head}. This applies once the team is on the Team plan.`;
	if (st.monthUsdMicros === null) return `${head}.`;
	return `${head} (${fmtUsdMicros(shareUsdMicros(st.monthUsdMicros, st.current))} of ${fmtUsdMicros(st.monthUsdMicros)}).`;
}

/** The confirm question's words: "From 50% to 80%: one member may use up to $36.00 of the team's $45.00 a month." */
export function assistantShareConfirmLine(st: AssistantShareState, next: number): string {
	const head = `From ${st.current}% to ${next}%`;
	const dollars = st.monthUsdMicros !== null ? ` up to ${fmtUsdMicros(shareUsdMicros(st.monthUsdMicros, next))} of the team’s ${fmtUsdMicros(st.monthUsdMicros)} a month` : ` up to ${next}% of the team’s assistant dollars a month`;
	const after = next === SHARE_MAX ? 'any one member may use all of the team’s assistant dollars a month' : `one member may use${dollars}`;
	return `${head}: ${after}. It applies from each member’s next question.`;
}

/** Whether `next` is a share the API takes: whole, 1 to 100, and not the share now. */
export function assistantShareValid(st: AssistantShareState, next: number | null): next is number {
	return next !== null && Number.isInteger(next) && next >= SHARE_MIN && next <= SHARE_MAX && next !== st.current;
}
