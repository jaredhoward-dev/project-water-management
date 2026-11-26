// South African business days for the renewal notice (businessDays.ts). These
// run under the workspace's skewed TZ (CLAUDE.md rule 7, vitest.config.ts):
// every date is a plain YYYY-MM-DD, and saDate must not follow the process's
// zone.
import { describe, expect, it } from 'vitest';
import { addDays, businessDaysBetween, easterSunday, endDatesWithin, isBusinessDay, publicHolidays, saDate } from './businessDays.js';

describe('easterSunday', () => {
	it.each([
		[2024, '2024-03-31'],
		[2025, '2025-04-20'],
		[2026, '2026-04-05'],
		[2027, '2027-03-28'],
		[2038, '2038-04-25']
	])('%i: %s', (year, date) => expect(easterSunday(year)).toBe(date));
});

describe('publicHolidays', () => {
	it('2026: the fixed dates, Good Friday, Family Day, and the Monday after a Sunday holiday', () => {
		expect([...publicHolidays(2026)].sort()).toEqual([
			'2026-01-01',
			'2026-03-21', // a Saturday: no Monday for it
			'2026-04-03',
			'2026-04-06',
			'2026-04-27',
			'2026-05-01',
			'2026-06-16',
			'2026-08-09',
			'2026-08-10', // 9 August is a Sunday
			'2026-09-24',
			'2026-12-16',
			'2026-12-25',
			'2026-12-26'
		]);
	});

	it('a Sunday Christmas or Day of Goodwill moves to the Monday (2022, 2027), and a Sunday New Year (2023)', () => {
		expect(publicHolidays(2022).has('2022-12-26')).toBe(true);
		expect(publicHolidays(2027).has('2027-12-27')).toBe(true);
		expect(publicHolidays(2023).has('2023-01-02')).toBe(true);
	});

	it('a Sunday Christmas makes Tuesday the 27th a holiday too, as declared under s2A in 2011, 2016 and 2022 (issue #893)', () => {
		for (const y of [2011, 2016, 2022, 2033]) {
			expect(new Date(Date.UTC(y, 11, 25)).getUTCDay()).toBe(0);
			expect(publicHolidays(y).has(`${y}-12-26`)).toBe(true);
			expect(publicHolidays(y).has(`${y}-12-27`)).toBe(true);
			expect(isBusinessDay(`${y}-12-27`)).toBe(false);
		}
		// Positive control: the 28th is a business day, and in another year (Christmas on a Friday) the 27th is a Sunday, not added.
		expect(isBusinessDay('2022-12-28')).toBe(true);
		expect(publicHolidays(2026).has('2026-12-27')).toBe(false);
		// 2022: the 10 fixed dates, Good Friday, Family Day, 2 May (Workers' Day on a Sunday) and the 27th; the Monday after Christmas is the 26th, already counted.
		expect(publicHolidays(2022).size).toBe(14);
		// Across that Christmas: 23 Dec (Fri) to 29 Dec (Thu) has only the 28th between them.
		expect(businessDaysBetween('2022-12-23', '2022-12-29')).toBe(1);
	});
});

describe('isBusinessDay', () => {
	it('weekends and holidays are not; an ordinary weekday is (positive control)', () => {
		expect(isBusinessDay('2026-11-23')).toBe(true); // a Monday
		expect(isBusinessDay('2026-11-21')).toBe(false); // Saturday
		expect(isBusinessDay('2026-11-22')).toBe(false); // Sunday
		expect(isBusinessDay('2026-12-16')).toBe(false); // Day of Reconciliation, a Wednesday
		expect(isBusinessDay('2026-08-10')).toBe(false); // the Monday after Women's Day on a Sunday
		expect(isBusinessDay('2027-03-26')).toBe(false); // Good Friday
	});

	it('refuses a date that does not exist', () => {
		expect(() => isBusinessDay('2026-02-30')).toThrow(/not a date/);
		expect(() => isBusinessDay('2026-1-5')).toThrow(/not a date/);
	});
});

describe('businessDaysBetween', () => {
	it('counts neither end', () => {
		expect(businessDaysBetween('2026-11-23', '2026-11-24')).toBe(0);
		expect(businessDaysBetween('2026-11-23', '2026-11-25')).toBe(1);
		expect(businessDaysBetween('2026-11-23', '2026-11-23')).toBe(0);
		expect(businessDaysBetween('2026-11-25', '2026-11-23')).toBe(0);
	});

	it('across a weekend at a month edge', () => {
		expect(businessDaysBetween('2026-01-30', '2026-02-02')).toBe(0);
	});

	it('across the year edge, its holidays and weekends', () => {
		// 25 Dec (Fri, holiday) … 3 Jan: only 28–31 Dec count.
		expect(businessDaysBetween('2026-12-24', '2027-01-04')).toBe(4);
	});

	it('a leap day counts', () => {
		expect(businessDaysBetween('2028-02-28', '2028-03-01')).toBe(1);
	});

	it('a year has 365 days less weekends and weekday holidays', () => {
		// 2026: 261 weekdays; 13 holidays, of which 21 Mar and 26 Dec fall on a Saturday and 9 Aug on a Sunday (its Monday is one of the 13): 10 weekdays.
		expect(businessDaysBetween('2025-12-31', '2027-01-01')).toBe(261 - 10);
	});
});

describe('endDatesWithin', () => {
	it('bounds exactly the end dates whose count is in range (every start day of 2026–2028)', () => {
		for (let today = '2026-01-01'; today < '2029-01-01'; today = addDays(today, 1)) {
			const r = endDatesWithin(today, 45, 60)!;
			expect(businessDaysBetween(today, r.from), today).toBeGreaterThanOrEqual(45);
			expect(businessDaysBetween(today, addDays(r.from, -1)), today).toBeLessThan(45);
			expect(businessDaysBetween(today, r.to), today).toBeLessThanOrEqual(60);
			expect(businessDaysBetween(today, addDays(r.to, 1)), today).toBeGreaterThan(60);
		}
	});

	it('over December the range sits further out than over a quiet stretch', () => {
		// From Monday 23 Nov 2026: 5 days of November, 21 of December (less 16 and 25 Dec), 20 of January (less 1 Jan),
		// then 1–18 Feb: 14. Only Friday 19 Feb has exactly 60 between; Saturday 20 Feb already has 19 Feb too.
		expect(endDatesWithin('2026-11-23', 60, 60)).toEqual({ from: '2027-02-19', to: '2027-02-19' });
		expect(businessDaysBetween('2026-11-23', '2027-02-19')).toBe(60);
		expect(businessDaysBetween('2026-11-23', '2027-02-20')).toBe(61);
		// A weekday-only count would put it three business days sooner (16 Dec, 25 Dec, 1 Jan).
		expect(endDatesWithin('2026-11-23', 45, 60)).toEqual({ from: '2027-01-29', to: '2027-02-19' });
	});

	it('is null for an empty range', () => {
		expect(endDatesWithin('2026-11-23', 61, 60)).toBeNull();
	});
});

describe('saDate', () => {
	it('is the date in South Africa, whatever the process zone', () => {
		expect(saDate(new Date('2026-11-23T21:59:59Z'))).toBe('2026-11-23');
		expect(saDate(new Date('2026-11-23T22:00:00Z'))).toBe('2026-11-24'); // midnight SAST
		expect(saDate(new Date('2026-12-31T22:30:00Z'))).toBe('2027-01-01');
	});
});
