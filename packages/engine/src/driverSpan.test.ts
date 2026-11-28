// The span of the rain that can drive a run (docs/model.md §2.3, ./driverSpan.ts):
// prepareRun's window and the scenario checks' bound on a dated demand window
// both read it, so its rules are pinned here on their own. Run under the
// skewed TZ every engine test gets (vitest.config.ts): epoch days must not
// move with the zone, leap days included.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from './calendar';
import { rainDriverSpan, type DriverSpanInput } from './driverSpan';
import { ERA5L_SERIES_KEY, IMERG_SERIES_PREFIX, type DailySeries, type ModelInput, type RainSourcePeriod } from './project';

const s = (startDate: string, n: number): DailySeries => ({ startDate, values: new Array(n).fill(1) });
const span = (x: Partial<DriverSpanInput> & { series?: Record<string, DailySeries> }) =>
	rainDriverSpan({ catchment: undefined, gapRain: null, rainSource: [], ...x, series: (x.series ?? {}) as ModelInput['series'] });
const days = (a: string, b: string): [number, number] => [toEpochDay(a), toEpochDay(b)];
const period = (start: string, end: string): RainSourcePeriod => ({ start, end, series: 'rain_catchment_alt_mm', factors: new Array(12).fill(1), reason: 'test' });

describe('rainDriverSpan', () => {
	it('is [Infinity, -Infinity] with no rain value anywhere, empty series included', () => {
		expect(span({})).toEqual([Infinity, -Infinity]);
		expect(span({ catchment: s('2020-01-01', 0), series: { rain_chirps_mm: s('2020-01-01', 0) } })).toEqual([Infinity, -Infinity]);
	});

	it('spans the catchment rain, CHIRPS and the forecast together, inclusive, across a leap day', () => {
		// 2020-02-28 + 2 days is 2020-03-01 only through 29 February.
		expect(span({ catchment: s('2020-02-28', 3) })).toEqual(days('2020-02-28', '2020-03-01'));
		expect(
			span({
				catchment: s('2001-01-01', 365),
				series: { rain_chirps_mm: s('2000-06-01', 30), rain_forecast_mm: s('2002-01-10', 10) }
			})
		).toEqual(days('2000-06-01', '2002-01-19'));
	});

	it('lets the gap-filling products extend the end, never the start (engine ≥ 1.101.0)', () => {
		const series = {
			rain_chirps_mm: s('2010-01-01', 31),
			[ERA5L_SERIES_KEY]: s('1950-01-01', 365 * 70),
			[`${IMERG_SERIES_PREFIX}V07`]: s('2010-01-01', 40)
		};
		// CHIRPS alone: the products are ignored.
		expect(span({ series, gapRain: null })).toEqual(days('2010-01-01', '2010-01-31'));
		// ERA5-Land from 1950 reaches 2019 but doesn't pull the start back.
		const era = span({ series, gapRain: { product: 'era5l', imergLate: false } });
		expect(era[0]).toBe(toEpochDay('2010-01-01'));
		expect(era[1]).toBe(toEpochDay('1950-01-01') + 365 * 70 - 1);
		// IMERG Late's days past CHIRPS' end extend it; ERA5-Land's key isn't read under product 'chirps'.
		expect(span({ series, gapRain: { product: 'chirps', imergLate: true } })).toEqual(days('2010-01-01', '2010-02-09'));
	});

	it('never starts a span from a gap-filling product alone', () => {
		const series = { [ERA5L_SERIES_KEY]: s('2010-01-01', 10) };
		expect(span({ series, gapRain: { product: 'era5l', imergLate: true } })).toEqual([Infinity, -Infinity]);
	});

	it('counts a rain-source period’s series only inside its period, and both ends of the overlap', () => {
		const series = { rain_catchment_alt_mm: s('1990-01-01', 3650) };
		// The period is inside the series: the period bounds it.
		expect(span({ series, rainSource: [period('1992-03-01', '1992-03-31')] })).toEqual(days('1992-03-01', '1992-03-31'));
		// The period runs past the series: the series bounds it.
		expect(span({ series, rainSource: [period('1985-01-01', '2030-12-31')] })).toEqual([toEpochDay('1990-01-01'), toEpochDay('1990-01-01') + 3649]);
		// A period that misses the series adds nothing; nor does the series without a period.
		expect(span({ series, rainSource: [period('2005-01-01', '2005-12-31')] })).toEqual([Infinity, -Infinity]);
		expect(span({ series })).toEqual([Infinity, -Infinity]);
	});

	it('widens the catchment span on both sides by a rain-source period', () => {
		const series = { rain_catchment_alt_mm: s('1980-01-01', 365 * 40) };
		expect(span({ catchment: s('2000-01-01', 366), series, rainSource: [period('1995-01-01', '1995-12-31'), period('2005-07-01', '2005-07-31')] })).toEqual(
			days('1995-01-01', '2005-07-31')
		);
	});
});
