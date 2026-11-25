// The Prior donors layer's data (priorDonors.ts, issue #622): the kept donors
// from GET …/gr4j-prior as the map draws them (dots sized and labelled by
// weight, a line from the target to each, the target), why there are none,
// and when GRDC-Caravan is credited.
import { describe, expect, it } from 'vitest';
import type { Gr4jPrior, Gr4jPriorDonor } from '#lib/api/types.js';
import { caravanCredited, DONOR_RADIUS, donorBbox, donorRadius, donorsData, donorSummary, donorTargetName, donorView, NO_PRIOR, weightLabel } from './priorDonors';

const donor = (id: string, weight: number, lon = 19, lat = -33): Gr4jPriorDonor => ({
	id,
	lon,
	lat,
	areaKm2: 300,
	weight,
	distanceKm: 40,
	similarity: null,
	kgeFit: 0.7,
	kgeValidation: null,
	params: { x1: 300, x2: 0, x3: 80, x4: 1.5 }
});

const dataset = (over: Partial<NonNullable<Gr4jPrior['dataset']>> = {}): NonNullable<Gr4jPrior['dataset']> => ({
	dataset: 'synthetic',
	version: 'v1',
	source: 'Invented donors',
	method: 'GR4J',
	attribution: 'Synthetic test data',
	synthetic: true,
	donorSetSha256: 'ab'.repeat(32),
	donors: 14,
	...over
});

const target = (lon: number | null = 20, lat: number | null = -34, positionFrom: 'gauge' | 'boundary' | null = 'boundary') =>
	({ zoneNodeId: null, units: null, lon, lat, positionFrom, attributes: {}, pawcMm: null, soilProblem: null, climateYears: 10, rainFrom: 'catchment' }) as unknown as NonNullable<Gr4jPrior['target']>;

const prior = (over: Partial<Pick<Gr4jPrior, 'dataset' | 'target' | 'donors' | 'problem'>> = {}) => ({
	dataset: dataset(),
	target: target(),
	donors: [donor('B', 0.25, 19.5, -33.5), donor('A', 0.75, 19, -33)],
	problem: null,
	...over
});

describe('donorView', () => {
	it('lists the kept donors heaviest first, each labelled and sized by its weight, joined to the target', () => {
		const v = donorView(prior());
		expect(v.kind).toBe('donors');
		if (v.kind !== 'donors') return;
		expect(v.target).toEqual({ lon: 20, lat: -34, from: 'boundary' });
		expect(v.donors.map((d) => [d.id, d.label, d.radius])).toEqual([
			['A', '75 %', DONOR_RADIUS.max],
			['B', '25 %', donorRadius(0.25, 0.75)]
		]);
		expect(v.donors[1]!.radius).toBeGreaterThan(DONOR_RADIUS.min);
		expect(v.donors[1]!.radius).toBeLessThan(DONOR_RADIUS.max);
		expect(v).toMatchObject({ dataset: 'synthetic', version: 'v1', synthetic: true, credited: false });
	});

	it('breaks a tie in weight by id, so the list never reorders', () => {
		const v = donorView(prior({ donors: [donor('C', 0.5), donor('A', 0.5)] }));
		expect(v.kind === 'donors' && v.donors.map((d) => d.id)).toEqual(['A', 'C']);
	});

	it('says why there is nothing to draw: the route’s problem, else the panel’s line', () => {
		expect(donorView(prior({ dataset: null, donors: [], problem: 'No GR4J donor basins are loaded.' }))).toEqual({ kind: 'none', text: 'No GR4J donor basins are loaded.' });
		expect(donorView(prior({ target: target(null, null, null), donors: [], problem: 'There is no catchment boundary on the map' }))).toEqual({
			kind: 'none',
			text: 'There is no catchment boundary on the map'
		});
		// Donors back but no position (never expected): still nothing to join them to.
		expect(donorView(prior({ target: target(null, null, null) })).kind).toBe('none');
		expect(donorView(prior({ donors: [] }))).toEqual({ kind: 'none', text: NO_PRIOR });
	});
});

describe('donorRadius and weightLabel', () => {
	it('scales the dot’s area with the weight, the heaviest at the largest', () => {
		expect(donorRadius(1, 1)).toBe(DONOR_RADIUS.max);
		expect(donorRadius(0.25, 1)).toBe(DONOR_RADIUS.min + (DONOR_RADIUS.max - DONOR_RADIUS.min) * 0.5);
		expect(donorRadius(0, 1)).toBe(DONOR_RADIUS.min);
		expect(donorRadius(0.5, 0)).toBe(DONOR_RADIUS.min);
	});
	it('writes the weight as the panel does, whole percent', () => {
		expect(weightLabel(0.234)).toBe('23 %');
		expect(weightLabel(0.005)).toBe('1 %');
	});
});

describe('caravanCredited', () => {
	it('credits a real GRDC-Caravan set, never the synthetic one', () => {
		expect(caravanCredited(dataset())).toBe(false);
		expect(caravanCredited(dataset({ synthetic: false, dataset: 'GRDC-Caravan-D1', source: 'GRDC-Caravan', attribution: 'Donor flow records: GRDC-Caravan' }))).toBe(true);
		expect(caravanCredited(dataset({ synthetic: false, dataset: 'local', source: 'my own fits', attribution: '' }))).toBe(false);
		const v = donorView(prior({ dataset: dataset({ synthetic: false, source: 'GRDC-Caravan' }) }));
		expect(v.kind === 'donors' && v.credited).toBe(true);
	});
});

describe('donorsData', () => {
	it('is a line to each donor, then each donor’s dot with its radius and label, then the target', () => {
		const d = donorsData(donorView(prior()));
		expect(d.features.map((f) => f.properties.role)).toEqual(['link', 'link', 'donor', 'donor', 'target']);
		expect(d.features[0]!.geometry).toEqual({ type: 'LineString', coordinates: [[20, -34], [19, -33]] });
		expect(d.features[2]).toMatchObject({ properties: { role: 'donor', id: 'A', weight: 0.75, radius: DONOR_RADIUS.max, label: '75 %' }, geometry: { type: 'Point', coordinates: [19, -33] } });
		expect(d.features[4]!.geometry).toEqual({ type: 'Point', coordinates: [20, -34] });
	});
	it('is empty with no view or no prior', () => {
		expect(donorsData(null).features).toEqual([]);
		expect(donorsData({ kind: 'none', text: NO_PRIOR }).features).toEqual([]);
	});
});

describe('donorSummary', () => {
	it('says how many, from which set, and from where they are measured', () => {
		const v = donorView(prior({ target: target(20, -34, 'gauge') }));
		if (v.kind !== 'donors') throw new Error('no donors');
		expect(donorSummary(v)).toBe('2 donor basins the regional prior kept, from “synthetic” (v1), each joined to the calibration gauge; a bigger dot weighs more.');
	});

	it('names the zone the URL asked for (priorZone=)', () => {
		const v = donorView(prior({ target: target(20, -34, 'gauge') }));
		if (v.kind !== 'donors') throw new Error('no donors');
		const names = (id: string) => (id === 'n1' ? 'Weir A' : null);
		expect(donorTargetName(null, names)).toBeNull();
		expect(donorTargetName('outlet', names)).toBe('the outlet’s own zone');
		expect(donorTargetName('n1', names)).toBe('the zone at Weir A');
		expect(donorTargetName('gone', names)).toBe('the zone at its gauge');
		expect(donorSummary(v, 'the zone at Weir A')).toBe('2 donor basins the regional prior kept for the zone at Weir A, from “synthetic” (v1), each joined to the zone’s gauge; a bigger dot weighs more.');
	});
});

describe('donorBbox', () => {
	it('boxes the target and every donor, for the map to frame', () => {
		const v = donorView(prior({ target: target(20, -34, 'boundary') }));
		if (v.kind !== 'donors') throw new Error('no donors');
		const lons = [20, ...v.donors.map((d) => d.lon)];
		const lats = [-34, ...v.donors.map((d) => d.lat)];
		expect(donorBbox(v)).toEqual([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]);
	});
});
