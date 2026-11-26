// The job's forecast part (store.ts forecastOutlook, docs/model.md §2.15d):
// it runs on the outlook's kept analogue years and no others. An outlook
// whose listed years all fall outside the record keeps none, so the forecast
// part must be off (noAnalogues), not quietly run on every year of the record.
// Invented catchment and forecasts (public repo).
import { describe, expect, it } from 'vitest';
import { outlookBaseAndSnapshot, runModelWithoutChecks, type ModelInput } from '@water-management/engine';
import { syntheticSystem } from '../../../packages/engine/src/outlook/forecastFixture.js';
import { testCatchment } from '../../../packages/engine/src/outlook/testCatchment.js';
import type { C3sInputs } from './c3s.js';
import { forecastOutlook } from './store.js';

const SEASON = { decisionDate: '2012-10-01', seasonEnd: '2013-04-30' };
const HINDCAST_YEARS = Array.from({ length: 24 }, (_, i) => 1988 + i);

describe('the job’s forecast part', () => {
	it('is off when the outlook kept no analogue year, rather than running on every year of the record', () => {
		const input = testCatchment({ start: '1985-10-01', end: '2013-09-30', seed: 3 }) as ModelInput;
		const plain = runModelWithoutChecks(input);
		const sys = syntheticSystem(plain, { id: 'sys-a', kind: 'climatology', members: 2, initMonth: 10, leads: 7, hindcastYears: HINDCAST_YEARS, forecastYear: 2012, seed: 20 });
		const { baseRun, snapshot } = outlookBaseAndSnapshot(input, SEASON.decisionDate);
		const inputs: C3sInputs = {
			forecasts: [sys.forecast],
			hindcasts: [sys.hindcast],
			source: { init: '2012-10', issued: [], notIssued: [], hindcasts: [], centres: [], fetchedAt: null, notes: [] },
			area: { source: 'boundary', cells: 1, units: [], notes: [] }
		} as unknown as C3sInputs;
		const f = forecastOutlook(input, { inputs }, { season: SEASON, baseRun, snapshot, analogueYears: [], reviewDate: null });
		expect(f.status).toBe('off');
		expect(f.reason).toBe('noAnalogues');
		expect(f.members).toEqual([]);
	});
});
