// The prerendered pricing page (/welcome/pricing) can't read the `plan` table,
// so it reads @water-management/engine/plans. This pins that file to the table
// the migrations wrote (323_billing and later), so a price or limit moved in
// one place and not the other fails here, not on the public page.
import { describe, expect, it } from 'vitest';
import { PLAN_FIGURES } from '@water-management/engine/plans';
import { asOwner } from '../__tests__/helpers.js';

interface PlanRow {
	code: string;
	price_monthly_minor: number;
	price_annual_minor: number;
	limits: Record<string, number | null>;
	features: Record<string, unknown>;
	trial_days: number;
}

describe('the pricing page figures', () => {
	it('match the plan table, plan by plan, and name every active plan', async () => {
		const rows = (await asOwner(
			`SELECT code, price_monthly_minor, price_annual_minor, limits, features, trial_days FROM plan WHERE active ORDER BY price_monthly_minor, code`
		)) as PlanRow[];
		expect(rows.map((r) => r.code)).toEqual(PLAN_FIGURES.map((p) => p.code));
		for (const row of rows) {
			const usdMicros = row.limits.assistant_usd_micros_per_month ?? row.limits.assistant_usd_micros_per_seat_month;
			const num = (v: unknown) => (v === undefined || v === null ? null : Number(v));
			expect({
				code: row.code,
				priceMonthlyMinor: Number(row.price_monthly_minor),
				priceAnnualMinor: Number(row.price_annual_minor),
				extraSeatMonthlyMinor: num(row.features.extra_seat_monthly_minor),
				extraSeatAnnualMinor: num(row.features.extra_seat_annual_minor),
				seatsIncluded: row.limits.seats_included,
				liveCatchments: row.limits.live_catchments,
				reportsPerMonth: row.limits.reports_per_month,
				packsIncludedPerMonth: row.limits.packs_included_per_month,
				packPriceMinor: num(row.features.pack_price_minor),
				assistantUsdPerMonth: usdMicros === null || usdMicros === undefined ? null : usdMicros / 1_000_000,
				scheduledReports: row.features.scheduled_reports,
				trialDays: row.trial_days
			}).toEqual(PLAN_FIGURES.find((p) => p.code === row.code));
		}
	});
});
