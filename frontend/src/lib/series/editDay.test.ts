import { describe, expect, it } from 'vitest';
import { handDayCount, handPoints, handRangesText, isHandDay, lastDay, readTypedValue, savedApplies, storedValue, valueOn } from './editDay';

const s = { startDate: '2021-10-01', values: [1.2, null, 0.6, 0.4] };

describe('the day edit', () => {
	it('reads the stored value of a day, a gap as null, and nothing outside the series', () => {
		expect(valueOn(s, '2021-10-01')).toBe(1.2);
		expect(valueOn(s, '2021-10-02')).toBeNull();
		expect(valueOn(s, '2021-10-04')).toBe(0.4);
		expect(valueOn(s, '2021-09-30')).toBeUndefined();
		expect(valueOn(s, '2021-10-05')).toBeUndefined();
		expect(valueOn(s, '')).toBeUndefined();
		expect(lastDay({ startDate: '2021-10-01', length: 4 })).toBe('2021-10-04');
	});

	it('says a day just saved as saved until the values reload, and only for that day (issue #932)', () => {
		const saved = { values: s, date: '2021-10-01', value: 9 };
		expect(storedValue(s, '2021-10-01', saved)).toBe(9);
		expect(savedApplies(saved, s, '2021-10-01')).toBe(true);
		// Another day reads as stored.
		expect(storedValue(s, '2021-10-03', saved)).toBe(0.6);
		expect(savedApplies(saved, s, '2021-10-03')).toBe(false);
		// A clear reads as no reading.
		expect(storedValue(s, '2021-10-01', { ...saved, value: null })).toBeNull();
		// Reloaded values (a new copy) are the truth, whatever they hold.
		const reloaded = { startDate: s.startDate, values: [7, null, 0.6, 0.4] };
		expect(storedValue(reloaded, '2021-10-01', saved)).toBe(7);
		expect(savedApplies(saved, reloaded, '2021-10-01')).toBe(false);
		// No values or no day: nothing to say; no save: as stored.
		expect(storedValue(null, '2021-10-01', saved)).toBeUndefined();
		expect(storedValue(s, '', saved)).toBeUndefined();
		expect(storedValue(s, '2021-10-01', null)).toBe(1.2);
	});

	it('reads a typed value with a decimal point or comma; blank clears; a negative or text is refused', () => {
		expect(readTypedValue('12.5')).toEqual({ ok: true, value: 12.5 });
		expect(readTypedValue(' 12,5 ')).toEqual({ ok: true, value: 12.5 });
		expect(readTypedValue('0')).toEqual({ ok: true, value: 0 });
		expect(readTypedValue('')).toEqual({ ok: true, value: null });
		expect(readTypedValue('   ')).toEqual({ ok: true, value: null });
		expect(readTypedValue('-1')).toMatchObject({ ok: false, error: expect.stringMatching(/below zero/) });
		expect(readTypedValue('abc')).toMatchObject({ ok: false, error: expect.stringMatching(/Type a number/) });
		expect(readTypedValue('1,2,3')).toMatchObject({ ok: false });
	});

	it('tells the hand-edited days, counts them and says them', () => {
		const ranges: [string, string][] = [
			['2021-10-02', '2021-10-02'],
			['2021-10-04', '2021-10-06']
		];
		expect(isHandDay(ranges, '2021-10-02')).toBe(true);
		expect(isHandDay(ranges, '2021-10-03')).toBe(false);
		expect(isHandDay(ranges, '2021-10-05')).toBe(true);
		expect(isHandDay(null, '2021-10-05')).toBe(false);
		expect(handDayCount(ranges)).toBe(4);
		expect(handDayCount(null)).toBe(0);
		expect(handRangesText(ranges)).toBe('2 Oct 2021, 4 Oct 2021 to 6 Oct 2021');
	});

	it('draws the hand-edited days that hold a value as points, clipped to the series', () => {
		expect(handPoints(s, [['2021-10-02', '2021-10-03']])).toEqual({ startDate: '2021-10-01', values: [null, null, 0.6, null] });
		expect(handPoints(s, [['2021-09-01', '2021-10-01']])).toEqual({ startDate: '2021-10-01', values: [1.2, null, null, null] });
		// Only a cleared day: nothing to draw.
		expect(handPoints(s, [['2021-10-02', '2021-10-02']])).toBeNull();
		expect(handPoints(s, null)).toBeNull();
	});
});
