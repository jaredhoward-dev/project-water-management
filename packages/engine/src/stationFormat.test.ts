import { describe, expect, it } from 'vitest';
import {
	atPath,
	formatStationTime,
	localToInstant,
	previewStationAnswer,
	readStationAnswer,
	type StationFormat,
	stationDays,
	StationFormatError,
	stationFormatProblem,
	stationRange,
	zoneOffsetMs
} from './stationFormat';

const SAST = 'Africa/Johannesburg';
const at = (iso: string) => Date.parse(iso);
/** Long after every day in these tests, so all of them have ended. */
const LATER = at('2030-01-01T00:00:00Z');

describe('paths', () => {
	const doc = { a: { list: [{ t: 1 }, { t: 2 }] }, sensors: [{ type: 3, data: ['x'] }, { type: 48, data: ['rain'] }] };
	it('reads keys, indexes and filters', () => {
		expect(atPath(doc, 'a.list[1].t')).toBe(2);
		expect(atPath(doc, 'sensors[type=48].data[0]')).toBe('rain');
		expect(atPath(doc, '')).toBe(doc);
		expect(atPath(doc, 'nope.deeper')).toBeUndefined();
		expect(atPath(doc, 'sensors[type=99].data')).toBeUndefined();
	});
	it('never reads inherited properties', () => {
		expect(atPath({}, 'constructor')).toBeUndefined();
		expect(atPath({}, '__proto__')).toBeUndefined();
	});
	it('reads a long run of [ in one pass (CodeQL js/polynomial-redos)', () => {
		// A regex scan of each [ to the end was quadratic: 100 000 of them took ~10 s, past vitest's 5 s timeout.
		const run = '['.repeat(100_000);
		expect(atPath([[1]], `${run}x`)).toBeUndefined();
		expect(atPath([[1]], `rows${run}`)).toBeUndefined();
		// One part, from the first [ to the ], holding the rest of the run: not an index or a filter.
		expect(atPath([[1]], `${run}]`)).toBeUndefined();
		expect(() => readStationAnswer('{"data":[]}', { ...daily, records: `${run}x` })).toThrow(/no list of records at/);
	});
	it('reads a path as the regex it replaced did', () => {
		// The pattern atPath used before the scan, kept here as the reference.
		const reference = (root: unknown, path: string): unknown => {
			if (path.trim() === '') return root;
			let cur: unknown = root;
			for (const raw of path.split('.')) {
				const m = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(raw.trim());
				if (!m) return undefined;
				if (m[1] !== '') {
					if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
					cur = Object.hasOwn(cur, m[1]!) ? (cur as Record<string, unknown>)[m[1]!] : undefined;
				}
				for (const b of m[2]!.match(/\[[^\]]*\]/g) ?? []) {
					if (!Array.isArray(cur)) return undefined;
					const inner = b.slice(1, -1).trim();
					if (/^\d+$/.test(inner)) cur = cur[Number(inner)];
					else {
						const eq = inner.indexOf('=');
						if (eq < 1) return undefined;
						const k = inner.slice(0, eq).trim();
						const want = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
						cur = cur.find((el) => el !== null && typeof el === 'object' && Object.hasOwn(el, k) && String((el as Record<string, unknown>)[k]) === want);
					}
				}
			}
			return cur;
		};
		const root = { a: [[{ b: 1, a: [0, { a: 2 }] }], { b: '0' }], '': [{ a: 3 }], ' a': 4 };
		const alphabet = ['a', 'b', '[', ']', '0', '1', '=', '.', ' ', '"', '[0]', '[b=1]', '[a]'];
		let seed = 784;
		const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
		for (let n = 0; n < 5000; n++) {
			let path = '';
			for (let len = next() % 9; len > 0; len--) path += alphabet[next() % alphabet.length];
			expect(atPath(root, path), path).toBe(reference(root, path));
		}
	});
});

describe('time zones', () => {
	it('knows SAST is UTC+2 and turns wall times into instants', () => {
		expect(zoneOffsetMs(SAST, at('2024-06-01T00:00:00Z'))).toBe(2 * 3600_000);
		expect(localToInstant(SAST, 2024, 6, 1, 8)).toBe(at('2024-06-01T06:00:00Z'));
	});
	it('handles a zone with daylight saving', () => {
		// London, summer (UTC+1) and winter (UTC+0).
		expect(localToInstant('Europe/London', 2024, 7, 1, 8)).toBe(at('2024-07-01T07:00:00Z'));
		expect(localToInstant('Europe/London', 2024, 1, 1, 8)).toBe(at('2024-01-01T08:00:00Z'));
	});
});

const daily: StationFormat = { format: 'json', records: 'data', time: 'date', value: 'rain', timeFormat: 'iso', resolution: 'daily' };

describe('daily records', () => {
	it('reads one total a day; a missing value is a gap, never a zero', () => {
		const text = JSON.stringify({ data: [{ date: '2024-03-01', rain: 1.5 }, { date: '2024-03-02', rain: null }, { date: '2024-03-04', rain: '0' }] });
		const r = readStationAnswer(text, daily);
		const d = stationDays(r, daily, '2024-03-01', '2024-03-04', LATER);
		expect(d).toEqual({ startDate: '2024-03-01', values: [1.5, null, null, 0], daysWithData: 2, gaps: 2 });
	});
	it('a day that has not ended yet is not written', () => {
		const text = JSON.stringify({ data: [{ date: '2024-03-01', rain: 1 }, { date: '2024-03-02', rain: 4 }] });
		const r = readStationAnswer(text, daily);
		// 2024-03-02 10:00 SAST: the 2nd is still running.
		const d = stationDays(r, daily, '2024-03-01', '2024-03-02', at('2024-03-02T08:00:00Z'));
		expect(d.values).toEqual([1]);
	});
	it('refuses two disagreeing totals for one day, and keeps an exact repeat', () => {
		const dup = JSON.stringify({ data: [{ date: '2024-03-01', rain: 1 }, { date: '2024-03-01', rain: 1 }] });
		expect(readStationAnswer(dup, daily).readings).toHaveLength(1);
		const bad = JSON.stringify({ data: [{ date: '2024-03-01', rain: 1 }, { date: '2024-03-01', rain: 2 }] });
		expect(() => readStationAnswer(bad, daily)).toThrow(/disagree/);
	});
});

describe('failing loudly', () => {
	it('names an HTML page, a missing list, a bad time and a bad value', () => {
		expect(() => readStationAnswer('<html>login</html>', daily)).toThrow(/web page/);
		expect(() => readStationAnswer('{"other":[]}', daily)).toThrow(/no list of records at “data”/);
		expect(() => readStationAnswer('{"data":[{"date":"01/03/2024","rain":1}]}', daily)).toThrow(/record 1: the time “01\/03\/2024” doesn’t match/);
		expect(() => readStationAnswer('{"data":[{"date":"2024-03-01","rain":"lots"}]}', daily)).toThrow(/record 1: the value “lots” is not a number/);
		expect(() => readStationAnswer('{"data":[{"date":"2024-02-30","rain":1}]}', daily)).toThrow(StationFormatError);
	});
	it('refuses a day above any believable rain (a wrong scale)', () => {
		const r = readStationAnswer('{"data":[{"date":"2024-03-01","rain":2500}]}', daily);
		expect(() => stationDays(r, daily, '2024-03-01', '2024-03-01', LATER)).toThrow(/more than any day’s rain/);
	});
});

const fiveMin: StationFormat = {
	format: 'csv',
	time: 'TIMESTAMP',
	value: 'Rain_mm_Tot',
	timeFormat: 'YYYY-MM-DD HH:mm:ss',
	timeZone: SAST,
	resolution: 'subdaily',
	missing: ['NAN']
};

describe('sub-daily readings into 08:00 rain days', () => {
	const csv = [
		'"TIMESTAMP","RECORD","Rain_mm_Tot"',
		'"2024-03-01 07:55:00",1,0.2', // before 08:00: the rain day of 29 Feb
		'"2024-03-01 08:00:00",2,0.4', // stamped at its end: still 29 Feb's rain day
		'"2024-03-01 08:05:00",3,1.0', // 1 March's
		'"2024-03-02 07:00:00",4,0.6', // 1 March's (before 08:00 on the 2nd)
		'"2024-03-02 09:00:00",5,0.2' // 2 March's
	].join('\n');

	it('credits each reading to the rain day it fell in', () => {
		const r = readStationAnswer(csv, fiveMin);
		const d = stationDays(r, fiveMin, '2024-02-29', '2024-03-02', LATER);
		expect(d.values).toEqual([0.6, 1.6, 0.2]);
	});
	it('a stamp at the start of its interval moves the 08:00 reading into the next day', () => {
		const f = { ...fiveMin, stampMarks: 'start' as const };
		const d = stationDays(readStationAnswer(csv, f), f, '2024-02-29', '2024-03-02', LATER);
		expect(d.values).toEqual([0.2, 2.0, 0.2]);
	});
	it('credits to the end day when the provider labels that way', () => {
		const f = { ...fiveMin, creditDayTo: 'end' as const };
		const d = stationDays(readStationAnswer(csv, f), f, '2024-03-01', '2024-03-03', LATER);
		expect(d.values).toEqual([0.6, 1.6, 0.2]);
	});
	it('a midnight day boundary sums by calendar day', () => {
		const f = { ...fiveMin, dayStartHour: 0 };
		const d = stationDays(readStationAnswer(csv, f), f, '2024-03-01', '2024-03-02', LATER);
		expect(d.values).toEqual([1.6, 0.8]);
	});
	it('a missing reading makes its day a gap (part of its rain is unknown)', () => {
		const withNan = `${csv}\n"2024-03-02 10:00:00",6,NAN`;
		const d = stationDays(readStationAnswer(withNan, fiveMin), fiveMin, '2024-03-02', '2024-03-02', LATER);
		expect(d.values).toEqual([null]);
	});
	it('the rain day still running is left out', () => {
		const d = stationDays(readStationAnswer(csv, fiveMin), fiveMin, '2024-02-29', '2024-03-02', at('2024-03-02T07:00:00Z'));
		// 09:00 SAST on the 2nd: the rain day of 1 March ended at 08:00, 2 March's runs on.
		expect(d.values).toEqual([0.6, 1.6]);
	});
	it('a day with no readings is a gap, or 0 for a logger that reports only rain', () => {
		const r = readStationAnswer(csv, fiveMin);
		expect(stationDays(r, fiveMin, '2024-03-03', '2024-03-03', LATER).values).toEqual([null]);
		const z = { ...fiveMin, noReadingsMeans: 'zero' as const };
		expect(stationDays(r, z, '2024-03-03', '2024-03-03', LATER).values).toEqual([0]);
		// An empty answer writes no zeros.
		expect(stationDays({ readings: [], records: 0 }, z, '2024-03-03', '2024-03-03', LATER).values).toEqual([null]);
	});
	it('names a missing column and reads columns by number without a header', () => {
		expect(() => readStationAnswer(csv, { ...fiveMin, value: 'Rain' })).toThrow(/no “Rain” column \(it has TIMESTAMP, RECORD, Rain_mm_Tot\)/);
		const f = { ...fiveMin, headerRow: false, skipLines: 1, time: '1', value: '3' };
		expect(readStationAnswer(csv, f).readings).toHaveLength(5);
	});
});

describe('running totals', () => {
	const f: StationFormat = { format: 'json', records: 'obs', time: 't', value: 'total', timeFormat: 'epoch_s', resolution: 'subdaily', valueKind: 'cumulative', dayStartHour: 0, timeZone: 'UTC' };
	const obs = (pairs: [string, number][]) => JSON.stringify({ obs: pairs.map(([t, total]) => ({ t: at(t) / 1000, total })) });
	it('sums the rises, and a drop is a reset whose new value is rain since it', () => {
		const text = obs([
			['2024-02-29T23:30:00Z', 10], // the reading before the window, to rise from
			['2024-03-01T00:30:00Z', 10],
			['2024-03-01T06:00:00Z', 12],
			['2024-03-01T23:30:00Z', 15],
			['2024-03-02T00:10:00Z', 0.4], // reset at midnight, then 0.4 fell
			['2024-03-02T12:00:00Z', 1.0]
		]);
		const d = stationDays(readStationAnswer(text, f), f, '2024-03-01', '2024-03-02', LATER);
		expect(d.values).toEqual([5, 1]);
	});
	it('makes a day a gap when its first reading has nothing before it to rise from (3-hourly, a window starting mid-record)', () => {
		const three = { ...f, dayStartHour: 8 };
		// 3-hourly totals from 08:00 on the 1st: a correct re-read would see the 05:00 reading of the day before, this answer doesn't.
		const text = obs([
			['2024-03-01T08:00:00Z', 20],
			['2024-03-01T11:00:00Z', 22],
			['2024-03-01T14:00:00Z', 25],
			['2024-03-02T05:00:00Z', 26],
			['2024-03-02T08:00:00Z', 26.5],
			['2024-03-02T11:00:00Z', 27],
			['2024-03-03T08:00:00Z', 27]
		]);
		const d = stationDays(readStationAnswer(text, three), three, '2024-02-29', '2024-03-02', LATER);
		// The 29th's rain day (to 08:00 on the 1st) holds the first reading, with nothing before it: a gap, not 0 (a
		// re-read would otherwise write a short total over a stored one). The 1st rises 22→26.5 = 6.5, the 2nd 26.5→27.
		expect(d.values).toEqual([null, 6.5, 0.5]);
		expect(d.gaps).toBe(1);
	});
	it('makes a missing reading a gap, and the day after it too when the rise from before it crosses into that day', () => {
		// Hourly totals from midnight; the logger lost the whole of the 2nd (null readings), then reads 20 on the 3rd.
		const missing = (z: string | null) => [`2024-03-02T${z}:30:00Z`, null] as const;
		const pairs: (readonly [string, number | null])[] = [
			['2024-02-29T23:30:00Z', 10],
			['2024-03-01T00:30:00Z', 10],
			['2024-03-01T12:00:00Z', 12],
			...['00', '06', '12', '23'].map(missing),
			['2024-03-03T12:00:00Z', 20],
			['2024-03-03T18:00:00Z', 21]
		];
		const text = JSON.stringify({ obs: pairs.map(([t, total]) => ({ t: at(t) / 1000, total })) });
		// The 3rd's first rise (12 → 20) holds the 2nd's rain, which no reading split: the 2nd and the 3rd are gaps,
		// never 8 mm on the 3rd (and, with noReadingsMeans 'zero', never 0 on the 2nd).
		for (const g of [f, { ...f, noReadingsMeans: 'zero' as const }]) {
			const d = stationDays(readStationAnswer(text, g), g, '2024-03-01', '2024-03-03', LATER);
			expect(d.values).toEqual([2, null, null]);
		}
	});
	it('makes a silent day a gap, and the day the rise from before it lands on too (engine ≥ 1.119.0)', () => {
		// Readings 10, 10, 12 on the 1st, nothing at all on the 2nd, then 20 and 21 on the 3rd.
		const text = obs([
			['2024-02-29T23:30:00Z', 10],
			['2024-03-01T00:30:00Z', 10],
			['2024-03-01T12:00:00Z', 12],
			['2024-03-03T12:00:00Z', 20],
			['2024-03-03T18:00:00Z', 21]
		]);
		// The 12 → 20 rise holds the 2nd's rain, which no reading split: never [2, 0, 9] ('zero') nor [2, null, 9] ('gap').
		for (const g of [f, { ...f, noReadingsMeans: 'zero' as const }]) {
			const d = stationDays(readStationAnswer(text, g), g, '2024-03-01', '2024-03-03', LATER);
			expect(d.values).toEqual([2, null, null]);
			expect(d.gaps).toBe(2);
		}
		// Positive control: the same readings on consecutive days keep every day's rain.
		const next = obs([
			['2024-02-29T23:30:00Z', 10],
			['2024-03-01T00:30:00Z', 10],
			['2024-03-01T12:00:00Z', 12],
			['2024-03-02T12:00:00Z', 20],
			['2024-03-02T18:00:00Z', 21]
		]);
		for (const g of [f, { ...f, noReadingsMeans: 'zero' as const }]) expect(stationDays(readStationAnswer(next, g), g, '2024-03-01', '2024-03-02', LATER).values).toEqual([2, 9]);
		// A total unchanged across the silence says no rain fell: the silent day is 0 for a logger whose silence means 0.
		const dry = obs([
			['2024-02-29T23:30:00Z', 10],
			['2024-03-01T12:00:00Z', 12],
			['2024-03-03T12:00:00Z', 12],
			['2024-03-03T18:00:00Z', 13]
		]);
		const z = { ...f, noReadingsMeans: 'zero' as const };
		expect(stationDays(readStationAnswer(dry, z), z, '2024-03-01', '2024-03-03', LATER).values).toEqual([2, 0, 1]);
		expect(stationDays(readStationAnswer(dry, f), f, '2024-03-01', '2024-03-03', LATER).values).toEqual([2, null, 1]);
	});
	it('keeps a rise across a missing reading inside the day it ends in, and gaps the missing readings left at the end', () => {
		const text = JSON.stringify({ obs: [['2024-02-29T23:30:00Z', 10], ['2024-03-01T06:00:00Z', null], ['2024-03-01T12:00:00Z', 12], ['2024-03-02T12:00:00Z', 13]].map(([t, total]) => ({ t: at(t as string) / 1000, total })) });
		const d = stationDays(readStationAnswer(text, f), f, '2024-03-01', '2024-03-02', LATER);
		// The 06:00 reading is missing, but 10 → 12 still falls on the 1st, as it would with no reading between.
		expect(d.values).toEqual([2, 1]);
		// Missing readings with nothing after them: their day's rain is unknown, a gap even for a logger whose silence means 0.
		const tail = JSON.stringify({ obs: [['2024-02-29T23:30:00Z', 10], ['2024-03-01T00:30:00Z', 10], ['2024-03-01T12:00:00Z', 12], ['2024-03-02T06:00:00Z', null]].map(([t, total]) => ({ t: at(t as string) / 1000, total })) });
		const z = { ...f, noReadingsMeans: 'zero' as const };
		expect(stationDays(readStationAnswer(tail, z), z, '2024-03-01', '2024-03-02', LATER).values).toEqual([2, null]);
	});
	it('asks from an hour before the first rain day, so its first interval has a reading to rise from', () => {
		const r = stationRange(f, '2024-03-01', '2024-03-01');
		expect(r).toEqual({ startMs: at('2024-02-29T23:00:00Z'), endMs: at('2024-03-02T00:00:00Z') });
	});
});

describe('records keyed by time (Ecowitt-style)', () => {
	it('reads an object of epoch → value, values as strings, inches scaled to mm', () => {
		const f: StationFormat = { format: 'json', records: 'data.rainfall.list', recordsKeyedByTime: true, time: '', value: '', timeFormat: 'epoch_s', resolution: 'subdaily', scale: 25.4, dayStartHour: 0, timeZone: 'UTC' };
		const text = JSON.stringify({ data: { rainfall: { list: { [at('2024-03-01T01:00:00Z') / 1000]: '0.10', [at('2024-03-01T02:00:00Z') / 1000]: '0.00' } } } });
		const d = stationDays(readStationAnswer(text, f), f, '2024-03-01', '2024-03-01', LATER);
		expect(d.values).toEqual([2.54]);
	});
});

describe('decimal commas and delimiters', () => {
	it('reads 1,5 with a ; delimiter and refuses a decimal comma with ,', () => {
		const f: StationFormat = { format: 'csv', delimiter: ';', decimalComma: true, time: 'Datum', value: 'Neerslag', timeFormat: 'DD/MM/YYYY', resolution: 'daily' };
		const r = readStationAnswer('Datum;Neerslag\n01/03/2024;1,5\n02/03/2024;0', f);
		expect(stationDays(r, f, '2024-03-01', '2024-03-02', LATER).values).toEqual([1.5, 0]);
		expect(stationFormatProblem({ ...f, delimiter: ',' })).toMatch(/decimal comma/);
	});
	it('refuses a decimal point under a decimal comma rather than read 1.5 as 15 mm', () => {
		const f: StationFormat = { format: 'csv', delimiter: ';', decimalComma: true, time: 'Datum', value: 'Neerslag', timeFormat: 'DD/MM/YYYY', resolution: 'daily' };
		expect(() => readStationAnswer('Datum;Neerslag\n01/03/2024;1.5', f)).toThrow(/line 2: the value “1\.5” is not a number/);
		expect(() => readStationAnswer('Datum;Neerslag\n01/03/2024;0.254', f)).toThrow(/“0\.254” is not a number/);
		expect(() => readStationAnswer('Datum;Neerslag\n01/03/2024;12.34,5', f)).toThrow(/not a number/);
		// A dot is still a thousands separator where it groups whole thousands.
		const r = readStationAnswer('Datum;Neerslag\n01/03/2024;1.234,5\n02/03/2024;-1.000', f);
		expect(r.readings.map((x) => x.value)).toEqual([1234.5, -1000]);
	});
});

describe('the URL’s {start} and {end}', () => {
	it('cover whole rain days from 08:00 SAST, in the format asked', () => {
		const f: StationFormat = { ...fiveMin };
		const r = stationRange(f, '2024-03-01', '2024-03-02');
		expect(formatStationTime(r.startMs, 'iso', SAST)).toBe('2024-03-01T08:00:00');
		expect(formatStationTime(r.endMs, 'YYYY-MM-DD HH:mm', SAST)).toBe('2024-03-03 08:00');
		expect(formatStationTime(r.startMs, 'epoch_s', SAST)).toBe(String(at('2024-03-01T06:00:00Z') / 1000));
	});
	it('a daily feed asks from midnight to midnight', () => {
		const r = stationRange({ ...daily, timeZone: SAST }, '2024-03-01', '2024-03-01');
		expect(formatStationTime(r.startMs, 'YYYYMMDD', SAST)).toBe('20240301');
		expect(formatStationTime(r.endMs, 'YYYYMMDD', SAST)).toBe('20240302');
	});
});

describe('format checks', () => {
	it('refuses an unknown zone, a pattern without its date, and a daily running total', () => {
		expect(stationFormatProblem({ ...daily, timeZone: 'Mars/Olympus' })).toMatch(/not a time zone/);
		expect(stationFormatProblem({ ...daily, timeFormat: 'HH:mm' })).toMatch(/needs YYYY/);
		expect(stationFormatProblem({ ...daily, valueKind: 'cumulative' })).toMatch(/sub-daily/);
	});
});

describe('the sample preview', () => {
	it('gives the days a pasted answer holds', () => {
		const p = previewStationAnswer(
			JSON.stringify({ data: [{ date: '2024-03-01', rain: 1 }, { date: '2024-03-03', rain: 2 }] }),
			daily,
			LATER
		);
		expect(p).toMatchObject({ startDate: '2024-03-01', values: [1, null, 2], records: 2, readings: 2 });
	});
});
