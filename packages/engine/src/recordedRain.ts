// The latest rain day: how far a project's recorded rain reaches, the one
// rule behind every "Rain to …" figure (the workspace header and Data tab,
// the project list's badge, the portfolio, the auto-run's window; issue
// #832). Recorded rain is what a run is driven by: a forecast runs into the
// future and observed flow only scores a run, so neither counts. Only the
// catchment's own rain counts (no site): a land unit's own rain series
// (209_unit_rain_series, issue #482) never moves it, since it covers one
// unit, not the catchment. The backend's SQL (backend/src/series/lastDay.ts
// recordedRainUntilSql) reads these kinds and the same no-site test.
import { fromEpochDay, toEpochDay } from './calendar';
import type { SeriesMeta } from './project';

/** The kinds of recorded rain: catchment gauge rain and CHIRPS. */
export const RECORDED_RAIN_KINDS = ['rain_catchment_mm', 'rain_chirps_mm'] as const;

/** A recorded rain kind (any site). */
export const isRecordedRain = (kind: string) => (RECORDED_RAIN_KINDS as readonly string[]).includes(kind);

/** Does this series count towards the project's latest rain day: recorded rain with no site (the catchment's, not a unit's). */
export const countsAsLatestRain = (s: Pick<SeriesMeta, 'kind' | 'siteNodeId'>) => isRecordedRain(s.kind) && !s.siteNodeId;

/**
 * How far a series' data reaches: its last day with a value (`lastValueDate`),
 * not the last day it stores; blank days after it are no data. A series with
 * no value at all "ends" the day before it starts. Without the field (an
 * older payload), the stored end.
 */
export function seriesLastValueDay(s: Pick<SeriesMeta, 'startDate' | 'length' | 'lastValueDate'>): string {
	if (s.lastValueDate === undefined) return fromEpochDay(toEpochDay(s.startDate) + Math.max(s.length, 1) - 1);
	return s.lastValueDate ?? fromEpochDay(toEpochDay(s.startDate) - 1);
}

/**
 * The project's latest rain day (YYYY-MM-DD): the newest last value of the
 * series that count; null when none does. A series with no value at all adds
 * nothing (as SQL's max skips its NULL).
 */
export function latestRainDay(list: readonly Pick<SeriesMeta, 'kind' | 'siteNodeId' | 'startDate' | 'length' | 'lastValueDate'>[]): string | null {
	let latest: string | null = null;
	for (const s of list) {
		if (!countsAsLatestRain(s) || s.lastValueDate === null) continue;
		const end = seriesLastValueDay(s);
		if (latest === null || end > latest) latest = end;
	}
	return latest;
}
