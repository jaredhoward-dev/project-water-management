// Report schedule timing (reports/due.ts). Every case runs under three process
// time zones, a day apart at the extremes (CLAUDE.md rule 7): a schedule's
// hour is in its OWN zone, so the machine's zone must never move it.
import { afterEach, describe, expect, it } from 'vitest';
import { dueFireAt, isValidTimeZone, latestFireAt, nextFireAt, type ScheduleTiming, zonedTimeToUtc } from './due.js';

const tz = process.env.TZ;
afterEach(() => {
	process.env.TZ = tz;
});

const ZONES = ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'];
const at = (iso: string) => new Date(iso);
const iso = (d: Date | null) => d?.toISOString() ?? null;

// Monday 07:00 in Johannesburg (UTC+2, no DST) = 05:00 UTC.
const mondaySast: ScheduleTiming = { frequency: 'weekly', weekday: 1, monthDay: null, hour: 7, timezone: 'Africa/Johannesburg' };
// The 1st of the month, 06:00 in Johannesburg = 04:00 UTC.
const firstSast: ScheduleTiming = { frequency: 'monthly', weekday: null, monthDay: 1, hour: 6, timezone: 'Africa/Johannesburg' };

describe.each(ZONES)('under TZ=%s', (zone) => {
	it('weekly: the latest Monday 07:00 SAST at or before now, and the next after it', () => {
		process.env.TZ = zone;
		// Wednesday 2026-09-23.
		expect(iso(latestFireAt(mondaySast, at('2026-09-23T12:00:00Z')))).toBe('2026-09-21T05:00:00.000Z');
		expect(iso(nextFireAt(mondaySast, at('2026-09-23T12:00:00Z')))).toBe('2026-09-28T05:00:00.000Z');
		// Monday itself, a minute before and exactly at the time.
		expect(iso(latestFireAt(mondaySast, at('2026-09-28T04:59:00Z')))).toBe('2026-09-21T05:00:00.000Z');
		expect(iso(latestFireAt(mondaySast, at('2026-09-28T05:00:00Z')))).toBe('2026-09-28T05:00:00.000Z');
		expect(iso(nextFireAt(mondaySast, at('2026-09-28T05:00:00Z')))).toBe('2026-10-05T05:00:00.000Z');
		// 23:30 UTC on Sunday is already Monday 01:30 in Johannesburg: this Monday's 07:00 is still ahead.
		expect(iso(latestFireAt(mondaySast, at('2026-09-27T23:30:00Z')))).toBe('2026-09-21T05:00:00.000Z');
		expect(iso(nextFireAt(mondaySast, at('2026-09-27T23:30:00Z')))).toBe('2026-09-28T05:00:00.000Z');
	});

	it('weekly across a year end, and Sunday (7)', () => {
		process.env.TZ = zone;
		const sunday: ScheduleTiming = { ...mondaySast, weekday: 7, hour: 18 };
		// Thursday 2027-01-01: the previous Sunday is 2026-12-27, 18:00 SAST = 16:00 UTC.
		expect(iso(latestFireAt(sunday, at('2027-01-01T00:00:00Z')))).toBe('2026-12-27T16:00:00.000Z');
		expect(iso(nextFireAt(sunday, at('2027-01-01T00:00:00Z')))).toBe('2027-01-03T16:00:00.000Z');
	});

	it('monthly: the 1st at 06:00 SAST, rolling over months and years', () => {
		process.env.TZ = zone;
		expect(iso(latestFireAt(firstSast, at('2026-09-15T00:00:00Z')))).toBe('2026-09-01T04:00:00.000Z');
		expect(iso(nextFireAt(firstSast, at('2026-09-15T00:00:00Z')))).toBe('2026-10-01T04:00:00.000Z');
		// 1 Jan 03:00 UTC is 05:00 SAST: before the time, so the latest is 1 Dec.
		expect(iso(latestFireAt(firstSast, at('2027-01-01T03:00:00Z')))).toBe('2026-12-01T04:00:00.000Z');
		expect(iso(nextFireAt(firstSast, at('2027-01-01T03:00:00Z')))).toBe('2027-01-01T04:00:00.000Z');
		const the28th: ScheduleTiming = { ...firstSast, monthDay: 28 };
		expect(iso(latestFireAt(the28th, at('2027-03-01T00:00:00Z')))).toBe('2027-02-28T04:00:00.000Z');
	});

	it('follows daylight saving in the schedule’s zone (New York, 09:00 local)', () => {
		process.env.TZ = zone;
		const ny: ScheduleTiming = { frequency: 'weekly', weekday: 1, monthDay: null, hour: 9, timezone: 'America/New_York' };
		// EDT (UTC-4) before 1 Nov 2026, EST (UTC-5) after.
		expect(iso(latestFireAt(ny, at('2026-10-27T00:00:00Z')))).toBe('2026-10-26T13:00:00.000Z');
		expect(iso(nextFireAt(ny, at('2026-10-27T00:00:00Z')))).toBe('2026-11-02T14:00:00.000Z');
		expect(zonedTimeToUtc(2026, 7, 1, 9, 'America/New_York')).toBe(Date.parse('2026-07-01T13:00:00Z'));
	});

	it('an hour skipped by daylight saving lands just after the gap, on its own day, whichever side of UTC the zone is', () => {
		process.env.TZ = zone;
		// New York springs forward at 02:00 on 8 Mar 2026: 02:00 is 03:00 EDT (07:00 UTC), never 01:00 EST the hour before.
		expect(zonedTimeToUtc(2026, 3, 8, 2, 'America/New_York')).toBe(Date.parse('2026-03-08T07:00:00Z'));
		// Berlin at 02:00 on 29 Mar 2026: 03:00 CEST (01:00 UTC).
		expect(zonedTimeToUtc(2026, 3, 29, 2, 'Europe/Berlin')).toBe(Date.parse('2026-03-29T01:00:00Z'));
		// Santiago skips Sunday 6 Sep 2026's midnight: a Sunday 00:00 schedule fires at 01:00 Sunday (04:00 UTC), not 23:00 on the Saturday.
		const sunday: ScheduleTiming = { frequency: 'weekly', weekday: 7, monthDay: null, hour: 0, timezone: 'America/Santiago' };
		expect(zonedTimeToUtc(2026, 9, 6, 0, 'America/Santiago')).toBe(Date.parse('2026-09-06T04:00:00Z'));
		// Saturday 23:30 there: the next time is still ahead, never one already past.
		const satNight = at('2026-09-06T03:30:00Z');
		expect(iso(nextFireAt(sunday, satNight))).toBe('2026-09-06T04:00:00.000Z');
		expect(iso(latestFireAt(sunday, satNight))).toBe('2026-08-30T04:00:00.000Z');
	});

	it('is due once per time, never for a time before the schedule was saved', () => {
		process.env.TZ = zone;
		const now = at('2026-09-23T12:00:00Z');
		const saved = { ...mondaySast, anchorAt: at('2026-09-22T10:00:00Z'), lastFiredFor: null };
		// Saved Tuesday: Monday 21st's time had passed, so nothing until the 28th.
		expect(dueFireAt(saved, now)).toBeNull();
		expect(iso(dueFireAt(saved, at('2026-09-28T05:00:00Z')))).toBe('2026-09-28T05:00:00.000Z');
		// Saved a month ago and never sent: the latest time, once.
		const old = { ...mondaySast, anchorAt: at('2026-08-20T00:00:00Z'), lastFiredFor: null };
		expect(iso(dueFireAt(old, now))).toBe('2026-09-21T05:00:00.000Z');
		expect(dueFireAt({ ...old, lastFiredFor: at('2026-09-21T05:00:00Z') }, now)).toBeNull();
		// A missed week is not replayed: only the latest time is due.
		expect(iso(dueFireAt({ ...old, lastFiredFor: at('2026-09-07T05:00:00Z') }, now))).toBe('2026-09-21T05:00:00.000Z');
	});
});

describe('isValidTimeZone', () => {
	it('knows IANA zones, and refuses anything else', () => {
		for (const z of ['Africa/Johannesburg', 'UTC', 'America/New_York']) expect(isValidTimeZone(z)).toBe(true);
		for (const z of ['', 'Mars/Olympus', 'GMT+99', 'x'.repeat(65)]) expect(isValidTimeZone(z)).toBe(false);
	});
});
