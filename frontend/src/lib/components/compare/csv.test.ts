import { describe, expect, it } from 'vitest';
import { metricDelta, type FarmDelta, type RunComparison } from '@water-management/engine';
import type { RunCompareResponse } from '#lib/api/types.js';
import { comparisonCsv, comparisonCsvName } from './csv';

const farm: FarmDelta = {
	name: 'Rooikloof',
	nameA: 'Old Rooikloof',
	nodeIdA: 'f1',
	nodeIdB: 'f1',
	demandM3Day: metricDelta(1000, 1000),
	suppliedM3Day: metricDelta(900, 450.5),
	deficitM3Day: metricDelta(100, 549.5),
	fractionSupplied: metricDelta(0.9, 0.4505),
	ewrShortfallM3Day: metricDelta(0, 0),
	daysEwrNotMet: metricDelta(0, 0)
};

/** A synthetic comparison with the fields the CSV reads. */
function response(over: { labelA?: string | null; changes?: RunCompareResponse['changes'] } = {}): RunCompareResponse {
	const side = (label: string | null, engine: string) => ({
		project: { id: 'p', name: 'Sandspruit' },
		run: { label, startDate: '2000-10-01', endDate: '2010-09-30', engineVersion: engine, summary: { farms: [] }, inputs: { model: { nodes: [] } } }
	});
	return {
		a: side(over.labelA === undefined ? 'Base' : over.labelA, '1.119.0'),
		b: side('Raised dam', '1.120.0'),
		comparison: {
			samePeriod: true,
			engineVersionChanged: true,
			farms: [farm],
			totals: { fractionSupplied: metricDelta(0.9, 0.4505), deficitM3Day: metricDelta(100, 549.5), farmsBelowTarget: metricDelta(1, 1) },
			catchment: { ewrFractionDaysNotMet: metricDelta(0.1, 0.25) }
		} as unknown as RunComparison,
		changes: over.changes ?? [{ area: 'network', kind: 'changed', subject: 'Rooikloof', text: 'Rooikloof: dam capacity 400 000 m³ → 400 000.4 m³' }],
		catchmentSeries: []
	} as unknown as RunCompareResponse;
}

const lines = (csv: string) => csv.split('\r\n');

describe('comparisonCsv', () => {
	it('writes the runs, the outcomes as raw numbers, each unit and every input change', () => {
		const out = lines(comparisonCsv(response()));
		expect(out.slice(0, 3)).toEqual(['Run,Label,Project,Start,End,Engine', 'Baseline (A),Base,Sandspruit,2000-10-01,2010-09-30,1.119.0', 'What-if (B),Raised dam,Sandspruit,2000-10-01,2010-09-30,1.120.0']);
		expect(out).toContain('Outcome,Unit,Baseline (A),What-if (B),Change (B − A)');
		// A fraction is written as a per cent, unrounded (the page shows 45%).
		expect(out).toContain('Irrigation supplied,% of demand (per cent),90,45.05,-44.95');
		expect(out).toContain('Irrigation deficit,m³/day,100,549.5,449.5');
		expect(out).toContain('Rooikloof (was Old Rooikloof),Supplied,m³/day,900,450.5,-449.5');
		expect(out).toContain('Rooikloof (was Old Rooikloof),Supplied,% of demand,90,45.05,-44.95');
		expect(out).toContain('Area,Kind,Subject,Change');
		expect(out).toContain('network,changed,Rooikloof,Rooikloof: dam capacity 400 000 m³ → 400 000.4 m³');
		expect(out.at(-1)).toBe('');
	});

	it('quotes commas and defuses a change a spreadsheet would read as a formula', () => {
		const out = comparisonCsv(response({ changes: [{ area: 'settings', kind: 'changed', subject: '=HYPERLINK("x")', text: 'Pragmatic EWR: Oct 10 → 0, Nov 10 → 0 m³/day' }] }));
		expect(out).toContain(`settings,changed,"'=HYPERLINK(""x"")","Pragmatic EWR: Oct 10 → 0, Nov 10 → 0 m³/day"`);
	});

	it('leaves out the unit table when neither run has a unit', () => {
		const r = response();
		r.comparison.farms = [];
		expect(comparisonCsv(r)).not.toContain('Hydrological unit,');
	});

	it('names the file after both runs', () => {
		expect(comparisonCsvName(response())).toBe('Base vs Raised dam - comparison.csv');
		expect(comparisonCsvName(response({ labelA: null }))).toBe('Untitled run vs Raised dam - comparison.csv');
	});
});
