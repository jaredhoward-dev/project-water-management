// The regional GR4J prior's donors on the Map tab (issue #622; docs/maps.md
// § Prior donors): what the Prior donors layer draws from GET
// /projects/:id/gr4j-prior's answer for the headline target (the catchment, or
// the headline calibration location): each kept donor's outlet as a dot sized
// by its weight and labelled with it, a thin line from the target's position
// (its gauge, else the boundary's centre) to each, and the target itself; or,
// with no prior, why not (the route's own problem). Pure (priorDonors.test.ts).
import type { Gr4jPrior } from '#lib/api/types.js';
import { fmtNum } from '#lib/format/number.js';

/** A donor's dot radius, px: the smallest weight kept at `min`, the largest at `max` (area-true: the radius goes with √weight). */
export const DONOR_RADIUS = { min: 5, max: 13 } as const;

/** A kept donor as the layer draws and lists it. */
export interface DonorMarker {
	id: string;
	lon: number;
	lat: number;
	/** Its weight in the prior, 0–1 (the kept donors' weights sum to 1). */
	weight: number;
	/** "23 %": the weight as the map labels it and the Regional prior panel writes it. */
	label: string;
	/** The dot's radius, px (donorRadius). */
	radius: number;
	distanceKm: number;
	areaKm2: number;
}

/** What the layer has to draw: the donors, or why there are none. */
export type DonorView =
	| { kind: 'none'; text: string }
	| {
			kind: 'donors';
			target: { lon: number; lat: number; from: 'gauge' | 'boundary' | null };
			/** Heaviest first (the list's order; ties by id). */
			donors: DonorMarker[];
			dataset: string;
			version: string;
			synthetic: boolean;
			/** The donor set is GRDC-Caravan's (not the synthetic one): the map credits it while drawn (mapLayers.ts mapCredits). */
			credited: boolean;
	  };

/** A weight as the panel writes it: whole percent. */
export const weightLabel = (w: number) => `${fmtNum(Math.round(w * 100))} %`;

/** A dot's radius for weight `w`, with `max` the heaviest kept donor's weight: √-scaled between DONOR_RADIUS.min and .max. */
export function donorRadius(w: number, max: number): number {
	if (!(max > 0) || !(w > 0)) return DONOR_RADIUS.min;
	const r = DONOR_RADIUS.min + (DONOR_RADIUS.max - DONOR_RADIUS.min) * Math.sqrt(Math.min(1, w / max));
	return Math.round(r * 10) / 10;
}

/** Whether a donor set is GRDC-Caravan's, whose CC BY 4.0 licence asks for a credit wherever its data is shown: never the synthetic set. */
export const caravanCredited = (d: { dataset: string; source: string; attribution: string; synthetic: boolean }) =>
	!d.synthetic && /caravan|grdc/i.test(`${d.dataset} ${d.source} ${d.attribution}`);

/** The words when there is no prior to draw: the route's problem, else the panel's line. */
export const NO_PRIOR = 'There is no prior for this catchment.';

/** What the layer draws from the route's answer. */
export function donorView(p: Pick<Gr4jPrior, 'dataset' | 'target' | 'donors' | 'problem'>): DonorView {
	const t = p.target;
	if (!p.dataset || !t || t.lon === null || t.lat === null || !p.donors.length) return { kind: 'none', text: p.problem ?? NO_PRIOR };
	const max = Math.max(...p.donors.map((d) => d.weight));
	const donors = p.donors
		.map((d) => ({ id: d.id, lon: d.lon, lat: d.lat, weight: d.weight, label: weightLabel(d.weight), radius: donorRadius(d.weight, max), distanceKm: d.distanceKm, areaKm2: d.areaKm2 }))
		.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
	return {
		kind: 'donors',
		target: { lon: t.lon, lat: t.lat, from: t.positionFrom },
		donors,
		dataset: p.dataset.dataset,
		version: p.dataset.version,
		synthetic: p.dataset.synthetic,
		credited: caravanCredited(p.dataset)
	};
}

/**
 * The `donors` source's data: a line from the target to each donor (under), each donor's dot with its radius and
 * weight label, and the target's point. Empty with no view or no donors.
 */
export function donorsData(v: DonorView | null | undefined) {
	if (!v || v.kind !== 'donors') return { type: 'FeatureCollection' as const, features: [] };
	const at: [number, number] = [v.target.lon, v.target.lat];
	return {
		type: 'FeatureCollection' as const,
		features: [
			...v.donors.map((d) => ({ type: 'Feature' as const, properties: { role: 'link' }, geometry: { type: 'LineString' as const, coordinates: [at, [d.lon, d.lat]] } })),
			...v.donors.map((d) => ({
				type: 'Feature' as const,
				properties: { role: 'donor', id: d.id, weight: d.weight, radius: d.radius, label: d.label },
				geometry: { type: 'Point' as const, coordinates: [d.lon, d.lat] }
			})),
			{ type: 'Feature' as const, properties: { role: 'target' }, geometry: { type: 'Point' as const, coordinates: at } }
		]
	};
}

/** The Layers box's summary line: how many donors, from which set, measured from where. */
export function donorSummary(v: Extract<DonorView, { kind: 'donors' }>): string {
	const n = v.donors.length;
	const from = v.target.from === 'gauge' ? 'the calibration gauge' : 'the catchment boundary’s centre';
	return `${n} donor ${n === 1 ? 'basin' : 'basins'} the regional prior kept, from “${v.dataset}” (${v.version}), each joined to ${from}; a bigger dot weighs more.`;
}
