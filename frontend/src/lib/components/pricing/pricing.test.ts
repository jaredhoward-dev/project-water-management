import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n/locale.svelte.js';
import { assistantTimesFree, monthsFreeYearly, planFigures, rand, reverseTrialDays } from './pricing';

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
});
