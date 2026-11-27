import { defaultProjectSettings, type CalibrationReport, type ProjectSettings, type ZoneFitStep } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { unappliedFitCaveats } from './unappliedFit';

const scores = { days: 100, kgePrime: 0.8, kgeYearly: null, kgeNp: 0.5, nse: 0.4, nseSqrt: 0.5, nseLog: 0.3, kgeLowHigh: 0.4, volumeErrorPct: 5, fdcHighPct: -10, fdcMidSlopePct: 20, fdcLowPct: 3 };
const period = { start: '2003-01-01', end: '2008-12-31', waterYears: [2002, 2003, 2004, 2005, 2006, 2007, 2008], scores };

function report(over: Partial<CalibrationReport> = {}): CalibrationReport {
	return {
		model: 'gr4j',
		objective: 'kgePrime',
		bounds: 'wide',
		budget: 100,
		seed: 1,
		starts: 1,
		startResults: [{ seed: 1, params: { x1: 800, x2: 0, x3: 40, x4: 1.2 }, score: 0.8, best: true }],
		free: ['x1', 'x3', 'x4'],
		params: { x1: 800, x2: 0, x3: 40, x4: 1.2 },
		startParams: { x1: 350, x2: 0, x3: 90, x4: 1.7 },
		flowKind: 'flow_observed_m3s',
		simulatedKey: 'simulated_outflow',
		fit: period,
		before: { ...period, scores: { ...scores, kgePrime: 0.2 } },
		splitSample: null,
		differential: null,
		independentRecord: null,
		notes: [],
		exclusions: [],
		evaluations: 100,
		cancelled: false,
		...over
	};
}

const step = (over: Partial<ZoneFitStep> = {}): ZoneFitStep => ({ zoneNodeId: null, name: 'Outlet', units: [], headline: true, report: report(), ...over });

describe('unappliedFitCaveats (issue #920)', () => {
	const ran = { settings: { ...defaultProjectSettings(), calibrationStart: '2003-01-01', calibrationEnd: '2008-12-31' } as ProjectSettings, validate: false, validationRecord: null };

	it('says nothing when the form is the one the fit ran on, though its parameters are still the old ones', () => {
		const form = { ...ran.settings, gr4j: { x1: 1, x2: 0, x3: 2, x4: 3 } } as ProjectSettings;
		expect(unappliedFitCaveats([step()], ran, form, [])).toEqual([]);
	});

	it('names a changed calibration window', () => {
		const form = { ...ran.settings, calibrationStart: '2004-01-01' };
		expect(unappliedFitCaveats([step()], ran, form, [])).toEqual(['The calibration window has changed since the fit.']);
	});

	it('names changed exclusions inside the fit’s window', () => {
		const form = { ...ran.settings, calibrationExclusions: [{ waterYear: 2005, reason: 'suspect rain' }] };
		expect(unappliedFitCaveats([step()], ran, form, [])).toEqual(['The calibration exclusions have changed since the fit.']);
	});

	it('names a changed calibration record', () => {
		const form = { ...ran.settings, calibrationFlowKind: 'flow_logger_m3s' as const };
		expect(unappliedFitCaveats([step()], ran, form, [])).toEqual(['The calibration flow series has changed since the fit.']);
	});

	it('prefixes each line with the location when the fit has several steps, once per line', () => {
		const form = { ...ran.settings, calibrationStart: '2004-01-01' };
		const lines = unappliedFitCaveats([step({ name: 'Outlet', headline: true }), step({ name: 'Outlet', headline: false })], ran, form, []);
		expect(lines).toEqual(['Outlet: The calibration window has changed since the fit.']);
	});
});
