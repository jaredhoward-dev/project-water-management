import { describe, expect, it } from 'vitest';
import { countsAsLatestRain, latestRainDay, RECORDED_RAIN_KINDS, seriesLastValueDay } from './recordedRain';

const s = (kind: string, startDate: string, length: number, extra: { siteNodeId?: string | null; lastValueDate?: string | null } = {}) => ({
	kind,
	startDate,
	length,
	...extra
});

describe('the latest rain day (issue #832)', () => {
	it('counts catchment gauge rain and CHIRPS with no site, never a forecast, a flow or a unit’s own rain', () => {
		expect([...RECORDED_RAIN_KINDS]).toEqual(['rain_catchment_mm', 'rain_chirps_mm']);
		expect(countsAsLatestRain({ kind: 'rain_catchment_mm' })).toBe(true);
		expect(countsAsLatestRain({ kind: 'rain_chirps_mm', siteNodeId: null })).toBe(true);
		expect(countsAsLatestRain({ kind: 'rain_catchment_mm', siteNodeId: 'unit-1' })).toBe(false);
		expect(countsAsLatestRain({ kind: 'rain_forecast_mm' })).toBe(false);
		expect(countsAsLatestRain({ kind: 'flow_observed_m3s' })).toBe(false);
	});

	it('is the newest last value of the series that count', () => {
		const list = [
			s('rain_catchment_mm', '2025-01-01', 90), // to 31 Mar
			s('rain_chirps_mm', '2025-01-01', 100, { lastValueDate: '2025-04-05' }), // values to 5 Apr, blanks after
			s('rain_catchment_mm', '2025-01-01', 120, { siteNodeId: 'unit-1' }), // a unit's own, to 30 Apr
			s('rain_forecast_mm', '2025-04-01', 60),
			s('flow_observed_m3s', '2025-01-01', 200)
		];
		expect(latestRainDay(list)).toBe('2025-04-05');
		// Positive control: the unit's series with no site is the catchment's, and moves it.
		expect(latestRainDay([...list.slice(0, 2), { ...list[2]!, siteNodeId: null }])).toBe('2025-04-30');
	});

	it('is null with none that counts; a series with no value at all adds nothing (as SQL max skips NULL)', () => {
		expect(latestRainDay([])).toBeNull();
		expect(latestRainDay([s('rain_catchment_mm', '2025-01-01', 10, { siteNodeId: 'u' })])).toBeNull();
		expect(latestRainDay([s('rain_catchment_mm', '2025-01-01', 10, { lastValueDate: null })])).toBeNull();
		expect(seriesLastValueDay(s('rain_catchment_mm', '2025-01-01', 10, { lastValueDate: null }))).toBe('2024-12-31');
		expect(seriesLastValueDay(s('rain_catchment_mm', '2025-01-01', 10))).toBe('2025-01-10');
	});
});
