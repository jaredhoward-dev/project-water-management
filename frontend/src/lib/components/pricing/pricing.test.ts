import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n/locale.svelte.js';
import { assistantTimesFree, cardLines, coversPlan, monthsFreeYearly, planFigures, rand, reverseTrialDays } from './pricing';

afterEach(() => setLocale('en'));

describe('the pricing page figures', () => {
	it('writes ZAR cents as whole rand, grouped with a narrow no-break space', () => {
		expect(rand(0)).toBe('R 0');
		expect(rand(89900)).toBe('R 899');
		expect(rand(2499000)).toBe('R\u00a024\u202f990');
		expect(rand(12345)).toBe('R 123.45');
	});

	it('counts a year’s saving in months and the assistant against Free’s, from the plan figures', () => {
		expect(monthsFreeYearly(planFigures('pro'))).toBe(2);
		expect(monthsFreeYearly(planFigures('team'))).toBe(2);
		expect(monthsFreeYearly(planFigures('free'))).toBe(0);
		expect(assistantTimesFree(planFigures('pro'))).toBe(15);
		expect(assistantTimesFree(planFigures('free'))).toBe(1);
	});

	it('offers Pro’s trial days only for the exact flag `true` and a Pro with trial days', () => {
		expect(reverseTrialDays('true')).toBe(planFigures('pro').trialDays);
		expect(planFigures('pro').trialDays).toBe(14);
		for (const flag of [undefined, '', 'false', '1', 'TRUE', ' true']) expect(reverseTrialDays(flag)).toBeNull();
		expect(reverseTrialDays('true', { ...planFigures('pro'), trialDays: 0 })).toBeNull();
	});

	it('lists each card’s live catchments, reports and scheduled report emails from the figures (#941)', () => {
		expect(cardLines(planFigures('free'))).toEqual({ live: { count: planFigures('free').liveCatchments }, reports: { count: planFigures('free').reportsPerMonth }, scheduledReports: false });
		expect(cardLines(planFigures('pro'))).toEqual({ live: 'every', reports: 'unlimited', scheduledReports: true });
		expect(cardLines({ ...planFigures('pro'), reportsPerMonth: 20, scheduledReports: false })).toMatchObject({ reports: { count: 20 }, scheduledReports: false });
	});

	it('“Everything in Free” and “Everything in Pro” hold: Pro’s figures cover Free’s, Team’s cover Pro’s (#941)', () => {
		expect(coversPlan(planFigures('pro'), planFigures('free'))).toBe(true);
		expect(coversPlan(planFigures('team'), planFigures('pro'))).toBe(true);
		expect(coversPlan(planFigures('free'), planFigures('pro'))).toBe(false);
		expect(coversPlan({ ...planFigures('team'), scheduledReports: false }, planFigures('pro'))).toBe(false);
	});
});
