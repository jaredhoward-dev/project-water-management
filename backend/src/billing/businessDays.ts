// South African business days, for the annual renewal notice (issue #641 §
// Billing provider; docs/billing.md § Renewal notice).
//
// The Consumer Protection Act s14(2)(c) has the notice reach the consumer
// "not more than 80, nor less than 40 business days" before a fixed-term
// agreement expires. Its s2(1)(b) counts business days without Saturdays,
// Sundays and public holidays, so the count needs the holidays: across
// December and Easter a weekday-only count runs up to six days long, which at
// the 40-day edge would send a notice that is in fact late.
//
// The holidays are the Public Holidays Act 36 of 1994's schedule: ten fixed
// dates, Good Friday and Family Day (the Monday after Easter), and s2(2)'s
// rule that a holiday falling on a Sunday makes the Monday a holiday too. A
// day the President declares a holiday later (an election day) is not known
// here: renewal.ts keeps a margin for those (RENEWAL_LATEST_BUSINESS_DAYS).
//
// Every date here is a calendar date in South Africa, `YYYY-MM-DD`, worked out
// in UTC arithmetic so the process's own time zone never moves a day.

/** `YYYY-MM-DD` → the UTC midnight of that date, in ms. */
function ms(date: string): number {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!m) throw new Error(`not a date: ${date}`);
	const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	if (iso(t) !== date) throw new Error(`not a date: ${date}`);
	return t;
}

const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const DAY = 86_400_000;

/** The date `n` calendar days after `date` (before it for a negative `n`). */
export function addDays(date: string, n: number): string {
	return iso(ms(date) + n * DAY);
}

/** Easter Sunday of a Gregorian year (the anonymous Gregorian algorithm, Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const month = Math.floor((h + l - 7 * m + 114) / 31);
	const day = ((h + l - 7 * m + 114) % 31) + 1;
	return iso(Date.UTC(year, month - 1, day));
}

/** The Public Holidays Act's fixed dates (MM-DD). */
const FIXED = ['01-01', '03-21', '04-27', '05-01', '06-16', '08-09', '09-24', '12-16', '12-25', '12-26'];

const cache = new Map<number, ReadonlySet<string>>();

/** South Africa's public holidays in a year, the Sunday rule's Mondays included. */
export function publicHolidays(year: number): ReadonlySet<string> {
	let set = cache.get(year);
	if (set) return set;
	const days = new Set<string>();
	const pad = String(year).padStart(4, '0');
	for (const md of FIXED) {
		const d = `${pad}-${md}`;
		days.add(d);
		// s2(2): a holiday on a Sunday makes the Monday after it a holiday.
		if (new Date(ms(d)).getUTCDay() === 0) days.add(addDays(d, 1));
	}
	const easter = easterSunday(year);
	days.add(addDays(easter, -2)); // Good Friday
	days.add(addDays(easter, 1)); // Family Day
	set = days;
	cache.set(year, set);
	return set;
}

/** Not a Saturday, a Sunday or a public holiday (CPA s2(1)(b)). */
export function isBusinessDay(date: string): boolean {
	const t = ms(date);
	const dow = new Date(t).getUTCDay();
	if (dow === 0 || dow === 6) return false;
	return !publicHolidays(new Date(t).getUTCFullYear()).has(date);
}

/**
 * The business days strictly between two dates: neither `from` (the day the
 * notice goes) nor `to` (the day the plan ends) counts, so the count is the
 * whole business days the consumer has. 0 when `to` is not after `from`.
 */
export function businessDaysBetween(from: string, to: string): number {
	let n = 0;
	for (let d = addDays(from, 1); d < to; d = addDays(d, 1)) if (isBusinessDay(d)) n++;
	return n;
}

/**
 * The end dates a notice sent on `today` is due for: every date whose
 * businessDaysBetween(today, date) is from `fewest` to `most`, as the first
 * and last such date (the count only grows with the date, so they bound a
 * plain date range). null when none is (fewest > most).
 */
export function endDatesWithin(today: string, fewest: number, most: number): { from: string; to: string } | null {
	if (!(fewest >= 0 && most >= fewest)) return null;
	let from: string | null = null;
	let to: string | null = null;
	let n = 0;
	// `n` counts the business days strictly between today and `d`; the business day `d` itself counts for the next date.
	for (let d = addDays(today, 1); n <= most; d = addDays(d, 1)) {
		if (n >= fewest) {
			from ??= d;
			to = d;
		}
		if (isBusinessDay(d)) n++;
	}
	return from && to ? { from, to } : null;
}

/** Today's date in South Africa (the app's zone, Africa/Johannesburg) at `now`. */
export function saDate(now: Date): string {
	// en-CA formats as YYYY-MM-DD.
	return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
