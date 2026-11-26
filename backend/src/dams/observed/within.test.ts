// The shared "two dam areas agree" rule (within.ts, issue #867).
import { describe, expect, it } from 'vitest';
import { OBSERVED } from './compare.js';
import { S1_AGREEMENT } from './sentinel/agreement.js';
import { WITHIN_REL_TOLERANCE, WITHIN_SHARE, withinOfFull } from './within.js';

describe('withinOfFull', () => {
	it('is the share both the comparison and the S1/S2 agreement use', () => {
		expect(WITHIN_SHARE).toBe(0.1);
		expect(OBSERVED.withinShare).toBe(WITHIN_SHARE);
		expect(S1_AGREEMENT.withinShare).toBe(WITHIN_SHARE);
	});

	it('counts a difference of exactly the band as within, though floating point rounds it over', () => {
		// 0.4 − 0.3 is 0.10000000000000003 > 0.1: the old m² form called this outside.
		expect(Math.abs(0.4 - 0.3) <= 0.1 * 1).toBe(false);
		expect(withinOfFull(0.4, 0.3, 1)).toBe(true);
		expect(withinOfFull(0.3, 0.4, 1)).toBe(true);
		// And the old share form on whole-m² areas: 4000/10000 − 3000/10000 is that same 0.10000000000000003.
		expect(Math.abs(4000 / 10_000 - 3000 / 10_000) <= 0.1).toBe(false);
		expect(withinOfFull(4000, 3000, 10_000)).toBe(true);
		expect(withinOfFull(15.600000000000001 * 0.4, 15.600000000000001 * 0.3, 15.600000000000001)).toBe(true);
	});

	it('still refuses anything past the band by more than rounding', () => {
		expect(withinOfFull(4000.01, 3000, 10_000)).toBe(false);
		expect(withinOfFull(3000, 4001, 10_000)).toBe(false);
		// The tolerance is relative to the band: 1e-9 of 0.1 F on a 1 km² dam is 0.1 mm².
		expect(WITHIN_REL_TOLERANCE * WITHIN_SHARE * 1e6).toBeLessThan(1e-3);
		expect(withinOfFull(1e6 * 0.1 + 1e-3, 0, 1e6)).toBe(false);
	});

	it('takes another share', () => {
		expect(withinOfFull(1250, 1000, 1000, 0.25)).toBe(true);
		expect(withinOfFull(1251, 1000, 1000, 0.25)).toBe(false);
	});
});
