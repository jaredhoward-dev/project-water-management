// Fit GR4J to GRDC-Caravan's gauged basins on the app's own forcing, for the
// regional prior's donor set (issue #622 step 3; docs/model.md §2.10m,
// docs/deployment.md § Reference datasets, GR4J donors). Operator-run and
// offline, never by the app:
//
//   pnpm fit-donors --caravan <dir> --basins <basins.geojson> --out <donors.json[.gz]>
//       [--from 1981-01-01] [--to YYYY-MM-DD] [--product sat|rnl]
//       [--evaporation <dataset>] [--soils <dataset>] [--max-area <km²>]
//       [--min-kge 0.5] [--only <id,…>] [--budget 1500] [--starts 5] [--seed 1]
//
//  --caravan  the unzipped GRDC_Caravan_extension_csv/ (Zenodo
//             10.5281/zenodo.15349031): attributes/grdc/attributes_other_grdc.csv
//             (outlet, area, country), attributes_hydroatlas_grdc.csv
//             (HydroATLAS's attributes) and timeseries/csv/grdc/<id>.csv
//             (the daily `streamflow`, mm/day; its ERA5-Land forcing is never read);
//  --basins   the basins' polygons as GeoJSON with a `gauge_id` property:
//             `ogr2ogr -f GeoJSON basins.geojson shapefiles/grdc/<file>.shp`.
//
// A donor (issue #622): a basin whose outlet is in region D1 (the copy's,
// mirror/grid.ts MIRROR_REGION), with under DONOR_MAX_DOR_PCT % upstream
// regulation (HydroATLAS dor_pc_pva, stored × 10), at most --max-area km²
// (default 10 000: a lumped GR4J over a larger basin says little about a
// catchment the app models), and at least DONOR_MIN_FLOW_YEARS of observed
// flow inside the window; once fitted, it needs a KGE′ of at least
// --min-kge (default 0.5) on its own record. Each is fitted with the engine's
// own calibrate() (KGE′, the typical bounds, x2 fixed at 0, the split-sample
// test run) on the forcing below; a basin with a day of no rain inside the
// copy's run is refused rather than run dry that day. Which free parameters
// each donor's fit left at a typical bound is recorded on the donor (atBound,
// 362) and the count per parameter printed. After the fits, the flow-space
// leave-one-out score (flowLeaveOneOut, 362): each donor in turn is the
// target of a prior built from the others, and the prior's p50s are run on
// its own forcing, scored by KGE′ against its flow beside its own fit's; the
// medians go into the file (looFlow). The forcing:
//
//  - rain: the area-weighted mean of the CHIRPS v3 cells the polygon covers
//    (each 0.05° cell by its area × the share inside, geo/gridShares.ts),
//    read from our rain data copy (MIRROR_URL), final days only, a cell with
//    no value (the sea) left out of the day's mean;
//  - PE: the evaporation grid's dPET monthly means over the polygon
//    (geo/evaporation.ts, the PE row Settings proposes), as settings.pe;
//  - never Caravan's ERA5-Land forcing: parameters absorb forcing bias
//    (especially x1), so a donor fitted on other rain would carry that bias
//    into every prior built from it.
//
// The soil grid's PAWC over the polygon is recorded when one is loaded
// (--soils, default the newest real one), for the soil x1 relation. The
// file holds only what was fitted (no flow), in the form
// geo/gr4jDonors.ts reads; refused basins are printed with their reason.
// It reads this checkout's database (MIGRATION_DATABASE_URL) for the grids.
import { loadDevEnv } from '../src/config/devEnv.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
	calibrate,
	ENGINE_VERSION,
	fromEpochDay,
	GR4J_PARAMS,
	kgePrime,
	PRIOR_LOO_MIN_DONORS,
	prepareCalibration,
	priorStartParams,
	regionalPrior,
	toEpochDay,
	type CalibrationProblem,
	type CalibrationReport,
	type Gr4jParams,
	type ModelInput,
	type NetworkNode
} from '@water-management/engine';
import pg from 'pg';
import { chcCell, decodeCellValue, type GridCell } from '../src/feeds/cellCache.js';
import { CHIRPS_CELL_DEG } from '../src/feeds/config.js';
import { evaporationDatasets, summariseEvaporation } from '../src/geo/evaporation.js';
import type { Geometry } from '../src/geo/geojson.js';
import { priorRanges } from '../src/calibration/prior.js';
import { DONOR_MAX_DOR_PCT, DONOR_MIN_FLOW_YEARS, donorsToJson, GR4J_DONORS, toEngineDonor, type AtBound, type DonorRecord, type LooFlowScore } from '../src/geo/gr4jDonors.js';
import { cellAreaM2, gridShares } from '../src/geo/gridShares.js';
import { soilDatasets, summariseSoil } from '../src/geo/soilGrid.js';
import { MIRROR_REGION, type Region } from '../src/mirror/grid.js';
import { readCells } from '../src/mirror/readCells.js';
import { mirrorStore } from '../src/mirror/source.js';
import type { MirrorStore } from '../src/mirror/store.js';

// ---------------------------------------------------------------------------
// Caravan's files
// ---------------------------------------------------------------------------

/** A CSV's rows as objects by header (quoted fields with commas and doubled quotes allowed). */
export function parseCsv(text: string): Record<string, string>[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else field += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') {
			row.push(field);
			field = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			field = '';
			if (row.length > 1 || row[0] !== '') rows.push(row);
			row = [];
		} else field += ch;
	}
	if (field !== '' || row.length) {
		row.push(field);
		rows.push(row);
	}
	const [head, ...body] = rows;
	if (!head) return [];
	return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** A basin as Caravan's attribute files describe it, in the donor's units. */
export interface CaravanBasin {
	id: string;
	lon: number;
	lat: number;
	areaKm2: number;
	country: string;
	attributes: DonorRecord['attributes'];
	/** dor_pc_pva ÷ 10, %; null when not given. */
	dorPct: number | null;
}

/** A HydroATLAS value: a number ≥ 0 (its no-data is −999 and the like), else null. */
const atlas = (v: string | undefined, scale = 1): number | null => {
	if (v === undefined || v.trim() === '') return null;
	const x = Number(v);
	return Number.isFinite(x) && x >= 0 ? x / scale : null;
};

/**
 * The basins of attributes_other_grdc.csv joined with
 * attributes_hydroatlas_grdc.csv by gauge_id. HydroATLAS's scaled integers are
 * converted: ari_ix_sav ÷ 100 (P/PET), slp_dg_sav ÷ 10 (degrees), dor_pc_pva ÷
 * 10 (%) (the BasinATLAS Catalog v1.0: "percent values are multiplied by
 * 10", and the same for slope; aridity × 100); cly_pc_sav, snd_pc_sav,
 * for_pc_sse (%) and pre_mm_syr (mm) as they are.
 */
export function caravanBasins(otherCsv: string, hydroatlasCsv: string): CaravanBasin[] {
	const atlasById = new Map(parseCsv(hydroatlasCsv).map((r) => [r.gauge_id!, r]));
	const out: CaravanBasin[] = [];
	for (const r of parseCsv(otherCsv)) {
		const id = r.gauge_id ?? '';
		const lon = Number(r.gauge_lon);
		const lat = Number(r.gauge_lat);
		const areaKm2 = Number(r.area);
		if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !Number.isFinite(lon) || !Number.isFinite(lat) || !(areaKm2 > 0)) continue;
		const h = atlasById.get(id) ?? {};
		const aridity = atlas(h.ari_ix_sav, 100);
		out.push({
			id,
			lon,
			lat,
			areaKm2,
			country: r.country ?? '',
			attributes: {
				aridity,
				mapMm: atlas(h.pre_mm_syr),
				slopeDeg: atlas(h.slp_dg_sav, 10),
				clayPct: atlas(h.cly_pc_sav),
				sandPct: atlas(h.snd_pc_sav),
				forestPct: atlas(h.for_pc_sse)
			},
			dorPct: atlas(h.dor_pc_pva, 10)
		});
	}
	return out;
}

export interface Selection {
	kept: CaravanBasin[];
	refused: { id: string; reason: string }[];
}

/** The basins that may be donors before any flow is read: outlet in the region, regulation under 5 %, area at most `maxAreaKm2`. */
export function selectCandidates(basins: readonly CaravanBasin[], opts: { region?: Region; maxAreaKm2?: number; only?: ReadonlySet<string> | null } = {}): Selection {
	const region = opts.region ?? MIRROR_REGION;
	const maxArea = opts.maxAreaKm2 ?? DEFAULT_MAX_AREA_KM2;
	const kept: CaravanBasin[] = [];
	const refused: Selection['refused'] = [];
	for (const b of basins) {
		if (opts.only && !opts.only.has(b.id)) continue;
		if (!(b.lon >= region.w && b.lon <= region.e && b.lat >= region.s && b.lat <= region.n)) continue;
		if (b.dorPct === null) refused.push({ id: b.id, reason: 'no degree of regulation (dor_pc_pva)' });
		else if (!(b.dorPct < DONOR_MAX_DOR_PCT)) refused.push({ id: b.id, reason: `regulated: ${b.dorPct.toFixed(1)} % (a donor is under ${DONOR_MAX_DOR_PCT} %)` });
		else if (b.areaKm2 > maxArea) refused.push({ id: b.id, reason: `${Math.round(b.areaKm2)} km², over --max-area ${maxArea}` });
		else kept.push(b);
	}
	return { kept, refused };
}

export const DEFAULT_MAX_AREA_KM2 = 10_000;

/** A Caravan timeseries file's `streamflow` (mm/day; empty = no value) from its first date. Refuses a gap in the dates. */
export function streamflowFromCsv(text: string): { startDate: string; mmPerDay: (number | null)[] } {
	const rows = parseCsv(text);
	if (!rows.length || !('streamflow' in rows[0]!) || !('date' in rows[0]!)) throw new Error('no date and streamflow columns');
	const startDate = rows[0]!.date!;
	const e0 = toEpochDay(startDate);
	const mmPerDay = rows.map((r, i) => {
		if (toEpochDay(r.date!) !== e0 + i) throw new Error(`the dates jump at ${r.date}`);
		const v = r.streamflow!.trim() === '' ? null : Number(r.streamflow);
		return v !== null && Number.isFinite(v) && v >= 0 ? v : null;
	});
	return { startDate, mmPerDay };
}

// ---------------------------------------------------------------------------
// Our forcing
// ---------------------------------------------------------------------------

/** The CHIRPS cells a polygon covers and each one's weight (its area on the ellipsoid × the share inside). */
export function basinCells(g: Geometry, maxCells = 20_000): { cells: GridCell[]; weights: number[] } | { problem: string } {
	// CHC's 0.05° grid has its corners on multiples of 0.05 (from −180, 60), so the grid frame is the degree frame.
	const shares = gridShares(g, CHIRPS_CELL_DEG, maxCells, undefined, 'CHIRPS');
	if ('problem' in shares) return shares;
	const cells: GridCell[] = [];
	const weights: number[] = [];
	for (const s of shares.cells) {
		const west = s.col * CHIRPS_CELL_DEG;
		const south = s.row * CHIRPS_CELL_DEG;
		cells.push(chcCell(south + CHIRPS_CELL_DEG / 2, west + CHIRPS_CELL_DEG / 2));
		weights.push(cellAreaM2(west, south, CHIRPS_CELL_DEG) * s.share);
	}
	if (!cells.length) return { problem: 'the polygon covers no CHIRPS cell' };
	return { cells, weights };
}

/**
 * Each day's area-weighted mean over the cells, from a readCells answer: a
 * day not read as final is null (the series ends before it), a cell with no
 * value (NaN, the sea) is left out of that day's mean, and a day no cell has
 * a value for is null.
 */
export function arealRain(read: string, values: readonly (readonly (number | null)[])[], weights: readonly number[]): (number | null)[] {
	return [...read].map((r, i) => {
		if (r !== 'f') return null;
		let sum = 0;
		let w = 0;
		for (let c = 0; c < values.length; c++) {
			const v = decodeCellValue(values[c]![i] ?? null);
			if (v === null || Number.isNaN(v)) continue;
			sum += weights[c]! * v;
			w += weights[c]!;
		}
		return w > 0 ? sum / w : null;
	});
}

const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'x',
	name: 'x',
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 0,
	pctUpstreamToDam: 0,
	pctRunoffToDam: 0,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	returnFlowFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

/**
 * A donor as the engine models it: one land unit of the basin's area (no
 * crops, no dam) draining to its gauge, so the simulated outflow is GR4J's
 * natural flow; the observed record is Caravan's streamflow in m³/s
 * (mm/day × km² × 1000 ÷ 86 400); PE the monthly row, Oct … Sep.
 */
export function donorInput(opts: { startDate: string; rainMm: (number | null)[]; flowMmPerDay: (number | null)[]; peMonthlyMm: number[]; areaKm2: number; peSource: string }): ModelInput {
	const toM3s = (opts.areaKm2 * 1000) / 86_400;
	return {
		settings: {
			runoffModel: 'gr4j',
			apanMm: opts.peMonthlyMm as never,
			pe: { kind: 'monthly', mm: opts.peMonthlyMm as never, source: opts.peSource.slice(0, 600) },
			gr4j: { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 }
		},
		model: {
			nodes: [node({ id: 'G', name: 'Gauge', kind: 'gauge' }), node({ id: 'B', name: 'Basin', downstreamNodeId: 'G', areaKm2: opts.areaKm2 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: opts.startDate, values: opts.rainMm },
			flow_observed_m3s: { startDate: opts.startDate, values: opts.flowMmPerDay.map((q) => (q === null ? null : q * toM3s)) }
		}
	} as ModelInput;
}

/** Observed days ÷ 365.25. */
export const flowYears = (flow: readonly (number | null)[]): number => flow.filter((q) => q !== null).length / 365.25;

export interface FitOptions {
	budget?: number;
	starts?: number;
	seed?: number;
}

/** The engine's own fit of one donor: KGE′, typical bounds, x2 fixed (calibrate's default free set). */
export function fitDonor(input: ModelInput, opts: FitOptions = {}): { params: Gr4jParams; kgeFit: number | null; kgeValidation: number | null; report: CalibrationReport } {
	const report = calibrate(input, { objective: 'kgePrime', bounds: 'typical', budget: opts.budget ?? 1500, starts: opts.starts ?? 5, seed: opts.seed ?? 1, validate: true });
	const p = report.params;
	return {
		params: { x1: p.x1!, x2: p.x2 ?? 0, x3: p.x3!, x4: p.x4! },
		kgeFit: report.fit.scores.kgePrime,
		kgeValidation: report.splitSample?.validation.scores.kgePrime ?? null,
		report
	};
}

/** Below this KGE′ on its own record a fit's parameters mean little, so the basin is no donor (the ensemble's behavioural threshold, §2.10e; the hydrologist's to confirm). */
export const DEFAULT_MIN_KGE = 0.5;

/**
 * The free parameters that ended within 1 % (of the box's width) of a typical
 * bound, with the side ('x4:high'), sorted: there the search, not the record,
 * set them. What a donor records as atBound (362).
 */
export function boundSides(params: Gr4jParams): AtBound[] {
	const out: AtBound[] = [];
	for (const p of GR4J_PARAMS) {
		if (p.fixedByDefault) continue;
		const [lo, hi] = p.typical;
		const tol = 0.01 * (hi - lo);
		if (params[p.key] <= lo + tol) out.push(`${p.key}:low` as AtBound);
		else if (params[p.key] >= hi - tol) out.push(`${p.key}:high` as AtBound);
	}
	return out.sort();
}

/** The free parameters that ended at a typical bound, either side (the counts the run prints). */
export const atBounds = (params: Gr4jParams): string[] => boundSides(params).map((b) => b.split(':')[0]!);

/**
 * KGE′ of `params` on a calibration problem's scored days (its observed flow
 * against the simulated, the engine's own kgePrime); null with too few days.
 * Both scores of the flow-space leave-one-out come from here, so the p50s and
 * the donor's own fit are judged on the same days.
 */
export function kgeOn(pb: Pick<CalibrationProblem, 'simulate' | 'observed' | 'scoredDays'>, params: Gr4jParams): number | null {
	const sim = pb.simulate({ ...params });
	const o: number[] = [];
	const s: number[] = [];
	for (const t of pb.scoredDays) {
		const v = pb.observed[t]!;
		if (!Number.isFinite(v)) continue;
		o.push(v);
		s.push(sim[t]!);
	}
	return kgePrime(o, s);
}

const median = (xs: number[]): number => {
	const a = [...xs].sort((x, y) => x - y);
	const m = a.length >> 1;
	return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};

export interface FlowLooDonor {
	id: string;
	/** KGE′ of the prior's p50s (built from the others) on this donor's record, and of its own fit on the same days. */
	kgePrior: number | null;
	kgeFit: number | null;
}

/**
 * The flow-space leave-one-out score of the regional prior on `donors`
 * (docs/model.md §2.10m): each donor in turn is the target (its outlet, its
 * attributes, its PAWC) of regionalPrior over the others with the default k
 * and similarity weight; the ranges a start would use (priorRanges: x1 from
 * the soil relation when it has skill) give its p50s (priorStartParams), which
 * are run on the donor's own forcing (`inputs`, the ModelInput it was fitted
 * on) and scored by KGE′ beside its own fitted parameters. The score is the
 * median over the donors both could be scored on; null with fewer than
 * PRIOR_LOO_MIN_DONORS of them.
 */
export function flowLeaveOneOut(donors: readonly DonorRecord[], inputs: ReadonlyMap<string, ModelInput>): { score: LooFlowScore | null; perDonor: FlowLooDonor[] } {
	const perDonor: FlowLooDonor[] = [];
	if (donors.length < PRIOR_LOO_MIN_DONORS) return { score: null, perDonor };
	for (const held of donors) {
		const input = inputs.get(held.id);
		if (!input) continue;
		const others = donors.filter((d) => d !== held).map(toEngineDonor);
		const prior = regionalPrior({ lon: held.lon, lat: held.lat, attributes: { ...held.attributes, areaKm2: held.areaKm2 }, pawcMm: held.pawcMm }, others, { leaveOneOut: false });
		if (!prior.ok) {
			perDonor.push({ id: held.id, kgePrior: null, kgeFit: null });
			continue;
		}
		const pb = prepareCalibration(input);
		perDonor.push({ id: held.id, kgePrior: kgeOn(pb, priorStartParams(priorRanges(prior).ranges)), kgeFit: kgeOn(pb, held.params) });
	}
	const both = perDonor.filter((d): d is FlowLooDonor & { kgePrior: number; kgeFit: number } => d.kgePrior !== null && d.kgeFit !== null);
	if (both.length < PRIOR_LOO_MIN_DONORS) return { score: null, perDonor };
	return { score: { kge: median(both.map((d) => d.kgePrior)), kgeFit: median(both.map((d) => d.kgeFit)), n: both.length }, perDonor };
}

/** The fit's method in words, stored with the set. */
export function fitMethod(o: { product: string; from: string; to: string; evaporation: string; budget: number; starts: number; seed: number; maxAreaKm2: number; minKge: number }): string {
	return (
		`GR4J (engine ${ENGINE_VERSION}) calibrated per basin with calibrate(): KGE′, Perrin’s typical bounds, x2 fixed at 0, ${o.starts} starts of ${o.budget} runs, seed ${o.seed}. ` +
		`Rain: CHIRPS v3 ${o.product} from our copy, area-weighted over the basin, ${o.from} to ${o.to} (final days only). PE: the evaporation grid “${o.evaporation}” (dPET monthly means) over the basin. ` +
		`Donors: GRDC-Caravan basins in region D1 with at least ${DONOR_MIN_FLOW_YEARS} years of flow in that window, under ${DONOR_MAX_DOR_PCT} % regulation (HydroATLAS dor_pc_pva) and at most ${o.maxAreaKm2} km², whose fit reached KGE′ ${o.minKge} or more. Caravan’s ERA5-Land forcing is not used.`
	);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface FitDonorsArgs {
	caravan: string;
	basins: string;
	out: string;
	from: string;
	to: string | null;
	product: 'sat' | 'rnl';
	evaporation: string | null;
	soils: string | null;
	maxAreaKm2: number;
	minKge: number;
	only: Set<string> | null;
	budget: number;
	starts: number;
	seed: number;
}

const FLAGS = ['--caravan', '--basins', '--out', '--from', '--to', '--product', '--evaporation', '--soils', '--max-area', '--min-kge', '--only', '--budget', '--starts', '--seed'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseFitDonorsArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): FitDonorsArgs | string {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '') : null;
	};
	const unknown = argv.find((a) => a.startsWith('--') && !FLAGS.includes(a));
	if (unknown) return `unknown option ${unknown}`;
	const path = (p: string) => resolve(env.INIT_CWD ?? process.cwd(), p);
	const caravan = flag('--caravan');
	const basins = flag('--basins');
	const out = flag('--out');
	if (!caravan) return 'give the unzipped GRDC_Caravan_extension_csv directory with --caravan';
	if (!basins) return 'give the basins’ polygons as GeoJSON with --basins (ogr2ogr -f GeoJSON from shapefiles/grdc/)';
	if (!out || !/\.json(\.gz)?$/i.test(out)) return 'give the donor file to write with --out (.json or .json.gz)';
	const from = flag('--from') ?? '1981-01-01';
	const to = flag('--to');
	if (!ISO.test(from) || (to !== null && (!ISO.test(to) || to < from))) return '--from and --to are YYYY-MM-DD, --to not before --from';
	const product = flag('--product') ?? 'sat';
	if (product !== 'sat' && product !== 'rnl') return '--product is sat or rnl (the copy’s CHIRPS v3 finals)';
	const int = (name: string, dflt: number, lo: number, hi: number) => {
		const v = flag(name);
		if (v === null) return dflt;
		const n = Number(v);
		return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
	};
	const budget = int('--budget', 1500, 100, 100_000);
	const starts = int('--starts', 5, 1, 10);
	const seed = int('--seed', 1, 0, 2 ** 31 - 1);
	const maxAreaKm2 = int('--max-area', DEFAULT_MAX_AREA_KM2, 1, 1_000_000);
	if (budget === null || starts === null || seed === null || maxAreaKm2 === null) return '--budget (100–100000), --starts (1–10), --seed and --max-area (km²) are whole numbers';
	const minKgeText = flag('--min-kge');
	const minKge = minKgeText === null ? DEFAULT_MIN_KGE : Number(minKgeText);
	if (!(Number.isFinite(minKge) && minKge <= 1)) return '--min-kge is a KGE′, at most 1';
	const onlyText = flag('--only');
	const only = onlyText === null ? null : new Set(onlyText.split(',').map((s) => s.trim()).filter(Boolean));
	return { caravan: path(caravan), basins: path(basins), out: path(out), from, to, product, evaporation: flag('--evaporation'), soils: flag('--soils'), maxAreaKm2, minKge, only, budget, starts, seed };
}

/** The polygons of a GeoJSON FeatureCollection by their gauge_id. */
export function basinPolygons(doc: unknown): Map<string, Geometry> {
	const out = new Map<string, Geometry>();
	const features = (doc as { features?: unknown[] })?.features;
	for (const f of Array.isArray(features) ? features : []) {
		const ft = f as { properties?: Record<string, unknown>; geometry?: Geometry };
		const id = ft.properties?.gauge_id;
		if (typeof id === 'string' && (ft.geometry?.type === 'Polygon' || ft.geometry?.type === 'MultiPolygon')) out.set(id, ft.geometry);
	}
	return out;
}

/** One basin's rain over the window from the copy, trimmed to its final days. */
export async function basinRain(store: MirrorStore, product: 'sat' | 'rnl', g: Geometry, window: { start: string; end: string }): Promise<{ startDate: string; rainMm: (number | null)[] } | { problem: string }> {
	const cells = basinCells(g);
	if ('problem' in cells) return cells;
	const got = await readCells(store, product, cells.cells, window);
	return trimRain(arealRain(got.cells.read, got.cells.values, cells.weights), window.start);
}

/**
 * A daily rain series from `start`, trimmed to its run of days with a value;
 * a day inside the run with none is a problem (it would run as 0 mm, the
 * engine's dry day, and bias the fit), as is a series with no value at all.
 */
export function trimRain(rain: (number | null)[], start: string): { startDate: string; rainMm: (number | null)[] } | { problem: string } {
	const first = rain.findIndex((v) => v !== null);
	if (first < 0) return { problem: 'the copy holds no final day of the window over it' };
	let last = rain.length - 1;
	while (rain[last] === null) last--;
	const gaps = rain.slice(first, last + 1).filter((v) => v === null).length;
	if (gaps) return { problem: `${gaps} day(s) inside the copy's run have no rain over it (they would run as dry days)` };
	return { startDate: fromEpochDay(toEpochDay(start) + first), rainMm: rain.slice(first, last + 1) };
}

/** The flow over [startDate, startDate + days), null outside the record. */
export function flowOver(flow: { startDate: string; mmPerDay: (number | null)[] }, startDate: string, days: number): (number | null)[] {
	const off = toEpochDay(startDate) - toEpochDay(flow.startDate);
	return Array.from({ length: days }, (_, i) => flow.mmPerDay[off + i] ?? null);
}

async function run(args: FitDonorsArgs, url: string): Promise<void> {
	const dir = args.caravan;
	const basins = caravanBasins(
		readFileSync(join(dir, 'attributes/grdc/attributes_other_grdc.csv'), 'utf8'),
		readFileSync(join(dir, 'attributes/grdc/attributes_hydroatlas_grdc.csv'), 'utf8')
	);
	const { kept, refused } = selectCandidates(basins, { maxAreaKm2: args.maxAreaKm2, only: args.only });
	const polygons = basinPolygons(JSON.parse(readFileSync(args.basins, 'utf8')));
	const store = mirrorStore();
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const evap = (await evaporationDatasets(client as never)).filter((d) => d.kind === 'et0' && (args.evaporation ? d.dataset === args.evaporation : !d.synthetic))[0];
		if (!evap) throw new Error(args.evaporation ? `no reference-ET evaporation dataset "${args.evaporation}" is loaded` : 'no real reference-ET evaporation grid (dPET) is loaded: pnpm import:evaporation first, or name one with --evaporation');
		const soil = (await soilDatasets(client)).filter((d) => (args.soils ? d.dataset === args.soils : !d.synthetic))[0] ?? null;
		if (args.soils && !soil) throw new Error(`no soil grid "${args.soils}" is loaded`);
		const to = args.to ?? fromEpochDay(Math.floor(Date.now() / 86_400_000));
		const donors: DonorRecord[] = [];
		// Each donor's forcing and flow, kept for the flow-space leave-one-out after the fits.
		const inputs = new Map<string, ModelInput>();
		const boundHits = new Map<string, number>();
		for (const [i, b] of kept.entries()) {
			const say = (m: string) => console.error(`[${i + 1}/${kept.length}] ${b.id}: ${m}`);
			const g = polygons.get(b.id);
			if (!g) {
				refused.push({ id: b.id, reason: 'no polygon in --basins' });
				continue;
			}
			const flow = streamflowFromCsv(readFileSync(join(dir, `timeseries/csv/grdc/${b.id}.csv`), 'utf8'));
			const rain = await basinRain(store, args.product, g, { start: args.from, end: to });
			if ('problem' in rain) {
				refused.push({ id: b.id, reason: rain.problem });
				continue;
			}
			const q = flowOver(flow, rain.startDate, rain.rainMm.length);
			const years = flowYears(q);
			if (years < DONOR_MIN_FLOW_YEARS) {
				refused.push({ id: b.id, reason: `${years.toFixed(1)} years of flow in the window (a donor has ${DONOR_MIN_FLOW_YEARS})` });
				continue;
			}
			const pe = await summariseEvaporation(client as never, evap, g);
			if ('problem' in pe) {
				refused.push({ id: b.id, reason: `PE: ${pe.problem}` });
				continue;
			}
			const pawc = soil ? await summariseSoil(client, soil, g) : null;
			say(`fitting on ${years.toFixed(1)} years`);
			const input = donorInput({ startDate: rain.startDate, rainMm: rain.rainMm, flowMmPerDay: q, peMonthlyMm: pe.monthlyMm, areaKm2: b.areaKm2, peSource: evap.source });
			const fit = fitDonor(input, args);
			if (fit.kgeFit === null) {
				refused.push({ id: b.id, reason: 'the fit has no KGE′ (too few scored days)' });
				continue;
			}
			if (fit.kgeFit < args.minKge) {
				refused.push({ id: b.id, reason: `KGE′ ${fit.kgeFit.toFixed(2)} on its own record, under --min-kge ${args.minKge}: its parameters say little` });
				continue;
			}
			const atBound = boundSides(fit.params);
			for (const b of atBound) boundHits.set(b, (boundHits.get(b) ?? 0) + 1);
			inputs.set(b.id, input);
			donors.push({
				id: b.id,
				lon: b.lon,
				lat: b.lat,
				areaKm2: b.areaKm2,
				attributes: b.attributes,
				dorPct: b.dorPct!,
				pawcMm: pawc && !('problem' in pawc) ? pawc.pawcMm : null,
				flowYears: Math.round(years * 100) / 100,
				params: fit.params,
				kgeFit: fit.kgeFit,
				kgeValidation: fit.kgeValidation,
				atBound
			});
			say(`x1 ${fit.params.x1.toFixed(0)}, x3 ${fit.params.x3.toFixed(0)}, x4 ${fit.params.x4.toFixed(2)}, KGE′ ${fit.kgeFit.toFixed(2)}`);
		}
		console.error(`flow-space leave-one-out over ${donors.length} donor(s)…`);
		const loo = flowLeaveOneOut(donors, inputs);
		const meta = {
			source: `GRDC-Caravan v0.6 daily streamflow (Zenodo 10.5281/zenodo.15349031) and HydroATLAS v1.0 attributes; GR4J fitted on CHIRPS v3 (${args.product}, our copy) and ${evap.dataset} PE`,
			version: `GRDC-Caravan 0.6; HydroATLAS 1.0; engine ${ENGINE_VERSION}`,
			method: fitMethod({ product: args.product, from: args.from, to, evaporation: evap.dataset, budget: args.budget, starts: args.starts, seed: args.seed, maxAreaKm2: args.maxAreaKm2, minKge: args.minKge }),
			attribution: GR4J_DONORS.attribution,
			engineVersion: ENGINE_VERSION,
			looFlow: loo.score
		};
		const json = donorsToJson(meta, donors);
		writeFileSync(args.out, /\.gz$/i.test(args.out) ? gzipSync(json) : json);
		for (const r of refused) console.log(`refused ${r.id}: ${r.reason}`);
		console.log(`${donors.length} donor(s) written to ${args.out}; ${refused.length} basin(s) in the region refused`);
		// A parameter stacked at a typical bound can't leave the box, which narrows the prior's p10–p90 (model.md §2.10m).
		for (const [p, n] of [...boundHits].sort()) console.log(`${p}: ${n} donor(s) ended within 1 % of that typical bound`);
		for (const d of loo.perDonor) console.log(`leave-one-out ${d.id}: KGE′ ${d.kgePrior?.toFixed(2) ?? '–'} from the prior's p50s, ${d.kgeFit?.toFixed(2) ?? '–'} its own fit`);
		console.log(
			loo.score
				? `flow-space leave-one-out: median KGE′ ${loo.score.kge.toFixed(2)} from the prior's p50s against ${loo.score.kgeFit.toFixed(2)} from the donors' own fits (${loo.score.n} donors)`
				: `flow-space leave-one-out: not scored (fewer than ${PRIOR_LOO_MIN_DONORS} donors could be)`
		);
	} finally {
		await client.end();
	}
}

const USAGE =
	'usage: pnpm fit-donors --caravan <dir> --basins <basins.geojson> --out <donors.json[.gz]> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--product sat|rnl] [--evaporation <dataset>] [--soils <dataset>] [--max-area <km²>] [--min-kge 0.5] [--only <id,…>] [--budget n] [--starts n] [--seed n]';

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const args = parseFitDonorsArgs(process.argv.slice(2));
	if (typeof args === 'string') {
		console.error(`${args}\n${USAGE}`);
		process.exit(2);
	}
	const url = process.env.MIGRATION_DATABASE_URL;
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	run(args, url).then(
		() => process.exit(0),
		(err: Error) => {
			console.error(err.message);
			process.exit(1);
		}
	);
}
