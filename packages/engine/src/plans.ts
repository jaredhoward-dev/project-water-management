// The billing plans' public figures (issue #641; docs/billing.md § Tables), as
// the prerendered pricing page (/welcome/pricing) shows them. The page is
// static HTML written at build time, so it can't read the `plan` table; it
// reads these instead. The `plan` table (323_billing, written only by
// migrations) stays the source of truth for what the backend charges and
// enforces: backend/src/billing/planFigures.db.test.ts fails when a migration
// moves a price or a limit and this file doesn't follow (and the other way
// round). Amounts are ZAR minor units (cents); null is unlimited.

export type PlanCode = 'free' | 'pro' | 'team';

export interface PlanFigures {
	readonly code: PlanCode;
	readonly priceMonthlyMinor: number;
	readonly priceAnnualMinor: number;
	/** Team only: the price of each editor seat past the included ones. */
	readonly extraSeatMonthlyMinor: number | null;
	readonly extraSeatAnnualMinor: number | null;
	/** Editor seats the price includes. */
	readonly seatsIncluded: number;
	/** Catchments running live (feeds, automatic runs, alerts, published farm views); null: every one. */
	readonly liveCatchments: number | null;
	/** Server PDF reports a month; null: unlimited. */
	readonly reportsPerMonth: number | null;
	/** Issued evidence packs a month included in the price. */
	readonly packsIncludedPerMonth: number;
	/** The price of each further issued pack. */
	readonly packPriceMinor: number;
	/** The assistant's allowance a month in US dollars, per person (Free, Pro) or per editor seat, pooled (Team). */
	readonly assistantUsdPerMonth: number;
	readonly scheduledReports: boolean;
}

export const PLAN_FIGURES: readonly PlanFigures[] = [
	{
		code: 'free',
		priceMonthlyMinor: 0,
		priceAnnualMinor: 0,
		extraSeatMonthlyMinor: null,
		extraSeatAnnualMinor: null,
		seatsIncluded: 1,
		liveCatchments: 1,
		reportsPerMonth: 5,
		packsIncludedPerMonth: 0,
		packPriceMinor: 149900,
		assistantUsdPerMonth: 1,
		scheduledReports: false
	},
	{
		code: 'pro',
		priceMonthlyMinor: 89900,
		priceAnnualMinor: 899000,
		extraSeatMonthlyMinor: null,
		extraSeatAnnualMinor: null,
		seatsIncluded: 1,
		liveCatchments: null,
		reportsPerMonth: null,
		packsIncludedPerMonth: 0,
		packPriceMinor: 99900,
		assistantUsdPerMonth: 15,
		scheduledReports: true
	},
	{
		code: 'team',
		priceMonthlyMinor: 249900,
		priceAnnualMinor: 2499000,
		extraSeatMonthlyMinor: 49900,
		extraSeatAnnualMinor: 499000,
		seatsIncluded: 3,
		liveCatchments: null,
		reportsPerMonth: null,
		packsIncludedPerMonth: 3,
		packPriceMinor: 99900,
		assistantUsdPerMonth: 15,
		scheduledReports: true
	}
];

export const planFigures = (code: PlanCode): PlanFigures => PLAN_FIGURES.find((p) => p.code === code)!;
