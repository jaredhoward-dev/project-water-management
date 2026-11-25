// The span of the rain series that can drive a run (docs/model.md §2.3): what
// prepareRun's window starts from before an explicit simulationStart / End
// replaces an end and an unset end moves in to the last rained day. Pure, so
// the scenario checks (scenario/overrides.ts, a dated demand.scale window)
// read the same span the run does and the two can't drift.
import { toEpochDay } from './calendar';
import { gapRainKeys } from './gapRain';
import type { DailySeries, ModelInput, ProjectSettings } from './project';

export interface DriverSpanInput {
	/** The catchment rain: rain_catchment_mm, or the catchment station's checked record in its place (engine ≥ 1.91.0). */
	catchment: DailySeries | undefined;
	series: ModelInput['series'];
	/** settings.gapRain as merged; pass null under a catchment station (its pairing fills its own gaps, §2.4i). */
	gapRain: ProjectSettings['gapRain'];
	/** settings.rainSource as the run reads it (none under a catchment station, whose record already holds them). */
	rainSource: ProjectSettings['rainSource'];
}

/**
 * The first and last epoch day of every rain series that can drive the run:
 * the catchment rain (or its station's record), CHIRPS and the forecast (as
 * before engine 0.45.0); the gap-filling products extend its end, never its
 * start (engine ≥ 1.101.0); a rain-source period's series inside its period
 * (engine ≥ 0.30.0). [Infinity, -Infinity] when none has a value.
 */
export function rainDriverSpan(x: DriverSpanInput): [number, number] {
	let first = Infinity;
	let last = -Infinity;
	for (const s of [x.catchment, x.series.rain_chirps_mm, x.series.rain_forecast_mm]) {
		if (!s || s.values.length === 0) continue;
		const d0 = toEpochDay(s.startDate);
		first = Math.min(first, d0);
		last = Math.max(last, d0 + s.values.length - 1);
	}
	// IMERG Late's recent days reach past CHIRPS', while a product record longer than the rain's (ERA5-Land from 1950)
	// doesn't pull the start back.
	if (x.gapRain && Number.isFinite(first))
		for (const k of gapRainKeys(x.gapRain, x.series)) {
			const s = (x.series as Record<string, DailySeries | undefined>)[k.key];
			if (s && s.values.length) last = Math.max(last, toEpochDay(s.startDate) + s.values.length - 1);
		}
	for (const p of x.rainSource) {
		const s = x.series[p.series];
		if (!s || s.values.length === 0) continue;
		const d0 = toEpochDay(s.startDate);
		const a = Math.max(d0, toEpochDay(p.start));
		const b = Math.min(d0 + s.values.length - 1, toEpochDay(p.end));
		if (a > b) continue;
		first = Math.min(first, a);
		last = Math.max(last, b);
	}
	return [first, last];
}
