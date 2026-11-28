// Where a run's forecast tail starts (docs/model.md §2.4f, ./forecastTail.ts):
// the first forecast-sourced day after the last day whose rain came from any
// other source. Each bullet of §2.4f's "Where the forecast starts" as its own
// case, on hand-made source columns, then forecastTail's two ways to read a
// prepared run's sources.
import { describe, expect, it } from 'vitest';
import { forecastTail, tailOfSource } from './forecastTail';
import type { SeriesKind } from './project';
import { RAIN_SOURCE_CODE as C } from './rainSourcePeriods';

const F = C.forecast;
const N = NaN;

describe('tailOfSource', () => {
	it('a forecast overlapping the record changes nothing there: the tail starts the day after the record', () => {
		// The column already says the record won its days; the forecast takes over after day 2.
		expect(tailOfSource([C.catchment, C.catchment, C.chirps, F, F])).toEqual({ lastObserved: 2, from: 3, historyDays: 3 });
	});

	it('forecast rain filling a gap inside the record is history, not the tail', () => {
		expect(tailOfSource([C.catchment, F, F, C.catchment, F, F])).toEqual({ lastObserved: 3, from: 4, historyDays: 4 });
	});

	it('days with no rain between the last observed day and the forecast are history', () => {
		expect(tailOfSource([C.catchment, N, N, F, F])).toEqual({ lastObserved: 0, from: 3, historyDays: 3 });
	});

	it('every non-forecast source counts as observed, the gap-filling products included', () => {
		for (const code of [C.catchment, C.series, C.chirps, C.reanalysis, C.era5l, C.imergLate]) {
			expect(tailOfSource([F, code, F]), `code ${code}`).toEqual({ lastObserved: 1, from: 2, historyDays: 2 });
		}
	});

	it('has no tail with no observed rain, with no forecast after the record, or with no days', () => {
		expect(tailOfSource([F, F, F])).toEqual({ lastObserved: -1, from: -1, historyDays: 3 });
		expect(tailOfSource([N, N])).toEqual({ lastObserved: -1, from: -1, historyDays: 2 });
		expect(tailOfSource([C.catchment, F, C.chirps, N])).toEqual({ lastObserved: 2, from: -1, historyDays: 4 });
		expect(tailOfSource([])).toEqual({ lastObserved: -1, from: -1, historyDays: 0 });
	});

	it('reads only the run’s days: a simulation end before the forecast leaves no tail', () => {
		expect(tailOfSource([C.catchment, C.catchment, F, F], 2)).toEqual({ lastObserved: 1, from: -1, historyDays: 2 });
		expect(tailOfSource([C.catchment, C.catchment, F, F], 3)).toEqual({ lastObserved: 1, from: 2, historyDays: 2 });
	});

	it('always splits the run into history then tail: historyDays is from when there is one, every day otherwise', () => {
		// Every column of three days over {catchment, forecast, none}.
		const codes = [C.catchment, F, N];
		for (const a of codes)
			for (const b of codes)
				for (const c of codes) {
					const col = [a, b, c];
					const t = tailOfSource(col);
					const label = col.join(',');
					if (t.from < 0) expect(t.historyDays, label).toBe(3);
					else {
						expect(t.historyDays, label).toBe(t.from);
						expect(col[t.from], label).toBe(F);
						expect(t.from, label).toBeGreaterThan(t.lastObserved);
						// Nothing observed in the tail.
						for (let i = t.from; i < 3; i++) expect(col[i] === F || Number.isNaN(col[i]!), label).toBe(true);
					}
				}
	});
});

describe('forecastTail', () => {
	const aligned = (cols: Partial<Record<SeriesKind, (number | null)[]>>) => (k: SeriesKind) => cols[k] ?? [];

	it('without rain-source periods, labels each day catchment, then CHIRPS, then forecast, as the rain is picked', () => {
		const t = forecastTail({
			days: 6,
			aligned: aligned({
				rain_catchment_mm: [1, null, null, null, null, null],
				rain_chirps_mm: [9, 2, null, null, null, null],
				rain_forecast_mm: [5, 5, null, 5, 5, null]
			}),
			rainSource: null
		});
		expect(Array.from(t.source)).toEqual([C.catchment, C.chirps, N, F, F, N]);
		expect(t).toMatchObject({ lastObserved: 1, from: 3, historyDays: 3 });
	});

	it('with rain-source periods, reads the column the periods built instead', () => {
		const column = Float64Array.from([C.series, C.series, F]);
		const t = forecastTail({
			days: 3,
			// The aligned series would say otherwise (all forecast): the column wins.
			aligned: aligned({ rain_catchment_mm: [null, null, null], rain_chirps_mm: [null, null, null], rain_forecast_mm: [1, 1, 1] }),
			rainSource: { column } as never
		});
		expect(t.source).toBe(column);
		expect(t).toMatchObject({ lastObserved: 1, from: 2, historyDays: 2 });
	});
});
