// The pricing page's figures (issue #641 Phase 4): every price and limit it
// shows comes from @water-management/engine/plans, which a backend DB test
// pins to the `plan` table (backend/src/billing/planFigures.db.test.ts), so
// nothing here is typed twice. Amounts in rand, grouped like the landing's
// other numbers (format.ts).
import { PLAN_FIGURES, planFigures, type PlanFigures } from '@water-management/engine/plans';
import { fmt } from '#lib/components/landing/format.js';

export { PLAN_FIGURES, planFigures, type PlanFigures };

/** ZAR cents as rand, whole rand when there are no cents: 89900 → "R 899", 899000 → "R 8 990". */
export function rand(minor: number): string {
	const r = minor / 100;
	return `R ${fmt(r, Number.isInteger(r) ? 0 : 2)}`;
}

/** How many months a year's price saves against twelve monthly ones (2 at R 8 990 against R 899). */
export const monthsFreeYearly = (p: PlanFigures): number =>
	p.priceMonthlyMinor > 0 ? Math.round(12 - p.priceAnnualMinor / p.priceMonthlyMinor) : 0;

/** A plan's assistant allowance as a multiple of Free's (Pro: 15). */
export const assistantTimesFree = (p: PlanFigures): number => Math.round(p.assistantUsdPerMonth / planFigures('free').assistantUsdPerMonth);

/**
 * Whether the page offers the reverse trial (billing.md § The reverse trial): the build's
 * PUBLIC_REVERSE_TRIAL, read like the backend's REVERSE_TRIAL (only the exact string `true`), and a Pro
 * `trial_days` above 0. The prerendered page can't ask the API, so the operator sets the build flag when
 * REVERSE_TRIAL and BILLING_ENFORCED go on (deployment.md); off (the default), the page offers nothing.
 */
export const reverseTrialDays = (flag: string | undefined, pro: PlanFigures = planFigures('pro')): number | null =>
	flag === 'true' && pro.trialDays > 0 ? pro.trialDays : null;

/**
 * What a plan card lists for its live catchments and reports, from the figures (#941: the cards' lists match them,
 * never typed): every catchment live or a count, unlimited reports or a count, and scheduled report emails when
 * the plan has them. The page words each kind.
 */
export interface CardLines {
	live: 'every' | { count: number };
	reports: 'unlimited' | { count: number };
	scheduledReports: boolean;
}

export const cardLines = (p: PlanFigures): CardLines => ({
	live: p.liveCatchments === null ? 'every' : { count: p.liveCatchments },
	reports: p.reportsPerMonth === null ? 'unlimited' : { count: p.reportsPerMonth },
	scheduledReports: p.scheduledReports
});

/**
 * Whether `a`'s figures give everything `b`'s do (Team's card says "Everything in Pro", Pro's "Everything in
 * Free"): as many or more live catchments, reports, packs and assistant, and scheduled reports when `b` has them.
 */
export function coversPlan(a: PlanFigures, b: PlanFigures): boolean {
	const atLeast = (x: number | null, y: number | null) => x === null || (y !== null && x >= y);
	return (
		atLeast(a.liveCatchments, b.liveCatchments) &&
		atLeast(a.reportsPerMonth, b.reportsPerMonth) &&
		a.packsIncludedPerMonth >= b.packsIncludedPerMonth &&
		a.packPriceMinor <= b.packPriceMinor &&
		a.assistantUsdPerMonth >= b.assistantUsdPerMonth &&
		(a.scheduledReports || !b.scheduledReports)
	);
}
