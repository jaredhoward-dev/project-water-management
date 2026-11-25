// The GR4J donor basins the regional prior is built from (269_gr4j_donors.sql;
// issue #622 step 3, docs/model.md §2.10m, docs/deployment.md § Reference
// datasets, GR4J donors):
//
//  - the file: the JSON `backend/scripts/fit-donors.ts` writes and the
//    committed synthetic fixture uses (`{ "kind": "gr4j-donors", "source",
//    "version", "method", "attribution", "engineVersion", "donors": [{ "id",
//    "lon", "lat", "areaKm2", "attributes": { aridity, mapMm, slopeDeg,
//    clayPct, sandPct, forestPct }, "dorPct", "pawcMm", "flowYears",
//    "params": { x1, x2, x3, x4 }, "kgeFit", "kgeValidation", "atBound" }, …],
//    "looFlow": { "kge", "kgeFit", "n" } }`, the last two optional, 362); a
//    production load reads the same file (geo/referenceLoad.ts);
//  - the load: the replace of a dataset, in one transaction, as the schema
//    owner, recording the set's SHA-256 (of engine donorSetCanonical);
//  - the read: one dataset's donors as the engine's Gr4jDonor, for
//    regionalPrior (the wiring is issue #622 step 5's).
//
// A donor is a basin with at least DONOR_MIN_FLOW_YEARS of flow and under
// DONOR_MAX_DOR_PCT % upstream regulation: the loader refuses any other, as
// the table's checks do. No flow is in the file: only what was fitted from it.
import { createHash } from 'node:crypto';
import { donorSetCanonical, GR4J_PARAMS, type CatchmentAttributes, type Gr4jDonor, type Gr4jParams } from '@water-management/engine';
import type pg from 'pg';
import type { Db } from '../db/tx.js';
import { recordReferenceOrigin, type ReferenceOrigin } from './referenceOrigin.js';

/** The label the committed fixture loads under. */
export const SYNTHETIC_DONOR_DATASET = 'synthetic';
/** Donor criteria (issue #622): at least this many years of observed flow in the fit window … */
export const DONOR_MIN_FLOW_YEARS = 8;
/** … and upstream regulation (HydroATLAS dor_pc_pva ÷ 10) under this, %. */
export const DONOR_MAX_DOR_PCT = 5;

/** What the operator's production load stores unless the file says otherwise (docs/data-sources.md § grdc-caravan, § hydroatlas). */
export const GR4J_DONORS = {
	attribution:
		'Donor flow records: GRDC-Caravan (Färber et al. 2025, Zenodo 10.5281/zenodo.15349031), CC BY 4.0, from data held by the Global Runoff Data Centre (GRDC); South Africa’s and Namibia’s records © their departments of water. Basin attributes: HydroATLAS v1.0 (BasinATLAS; Linke et al. 2019, Lehner et al. 2022), CC BY 4.0.'
} as const;

/** A free parameter a fit left within 1 % of a typical bound, and on which side (362). */
export const AT_BOUND_VALUES = ['x1:low', 'x1:high', 'x2:low', 'x2:high', 'x3:low', 'x3:high', 'x4:low', 'x4:high'] as const;
export type AtBound = (typeof AT_BOUND_VALUES)[number];

/**
 * The flow-space leave-one-out score (362; fit-donors.ts flowLeaveOneOut):
 * the median KGE′ of the prior's p50s run on each held-out donor's own
 * forcing, the median KGE′ of the same donors' own fits on the same days, and
 * how many were scored.
 */
export interface LooFlowScore {
	kge: number;
	kgeFit: number;
	n: number;
}

export interface DonorRecord {
	id: string;
	lon: number;
	lat: number;
	areaKm2: number;
	attributes: Omit<CatchmentAttributes, 'areaKm2'>;
	dorPct: number;
	pawcMm: number | null;
	flowYears: number;
	params: Gr4jParams;
	kgeFit: number;
	kgeValidation: number | null;
	/** The free parameters its fit left at a typical bound (sorted; [] none); null when the file didn't record it (362). */
	atBound: AtBound[] | null;
}

export interface DonorSetMeta {
	dataset: string;
	source: string;
	version: string;
	method: string;
	attribution: string;
	/** The engine that fitted them (ENGINE_VERSION). */
	engineVersion: string;
	/** The flow-space leave-one-out score; absent or null when the file has none (362). */
	looFlow?: LooFlowScore | null;
}

/** The engine's donor shape. */
export const toEngineDonor = (d: DonorRecord): Gr4jDonor => ({
	id: d.id,
	lon: d.lon,
	lat: d.lat,
	attributes: { ...d.attributes, areaKm2: d.areaKm2 },
	params: d.params,
	pawcMm: d.pawcMm
});

/** SHA-256 (hex) of the set's canonical form: what a prior built from it names. */
export const donorSetSha256 = (donors: readonly DonorRecord[]): string => createHash('sha256').update(donorSetCanonical(donors.map(toEngineDonor))).digest('hex');

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ATTR_RANGES: Record<keyof DonorRecord['attributes'], [number, number]> = {
	aridity: [0, Infinity],
	mapMm: [0, Infinity],
	slopeDeg: [0, 90],
	clayPct: [0, 100],
	sandPct: [0, 100],
	forestPct: [0, 100]
};

/** One donor from the file, or why it isn't one (fixed text: the file's values aren't echoed past the id). */
export function donorFromJson(raw: unknown): DonorRecord | string {
	const r = (raw ?? {}) as Record<string, unknown>;
	const id = typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(r.id) ? r.id : null;
	if (!id) return 'no id of 1–40 letters, digits, dashes or underscores';
	const lon = num(r.lon);
	const lat = num(r.lat);
	if (lon === null || lat === null || Math.abs(lon) > 180 || Math.abs(lat) > 90) return `${id}: no lon and lat in degrees`;
	const areaKm2 = num(r.areaKm2);
	if (!(areaKm2 !== null && areaKm2 > 0)) return `${id}: no area over 0 km²`;
	const a = (r.attributes ?? {}) as Record<string, unknown>;
	const attributes = {} as DonorRecord['attributes'];
	for (const [k, [lo, hi]] of Object.entries(ATTR_RANGES) as [keyof DonorRecord['attributes'], [number, number]][]) {
		const v = a[k] === null || a[k] === undefined ? null : num(a[k]);
		if (a[k] !== null && a[k] !== undefined && (v === null || v < lo || v > hi)) return `${id}: attribute ${k} is out of range`;
		attributes[k] = v;
	}
	const dorPct = num(r.dorPct);
	if (!(dorPct !== null && dorPct >= 0 && dorPct < DONOR_MAX_DOR_PCT)) return `${id}: not a donor: regulation must be under ${DONOR_MAX_DOR_PCT} %`;
	const flowYears = num(r.flowYears);
	if (!(flowYears !== null && flowYears >= DONOR_MIN_FLOW_YEARS)) return `${id}: not a donor: it needs at least ${DONOR_MIN_FLOW_YEARS} years of flow`;
	const pawcMm = r.pawcMm === null || r.pawcMm === undefined ? null : num(r.pawcMm);
	if (r.pawcMm !== null && r.pawcMm !== undefined && !(pawcMm !== null && pawcMm >= 0 && pawcMm <= 1000)) return `${id}: pawcMm is not 0–1000 mm`;
	const p = (r.params ?? {}) as Record<string, unknown>;
	const params = {} as Gr4jParams;
	for (const spec of GR4J_PARAMS) {
		const v = num(p[spec.key]);
		if (v === null || v < spec.min || v > spec.max) return `${id}: ${spec.key} is not within GR4J’s bounds (${spec.min}–${spec.max})`;
		params[spec.key] = v;
	}
	const kgeFit = num(r.kgeFit);
	if (!(kgeFit !== null && kgeFit <= 1)) return `${id}: no kgeFit of at most 1`;
	const kgeValidation = r.kgeValidation === null || r.kgeValidation === undefined ? null : num(r.kgeValidation);
	if (r.kgeValidation !== null && r.kgeValidation !== undefined && !(kgeValidation !== null && kgeValidation <= 1)) return `${id}: kgeValidation is not at most 1`;
	let atBound: AtBound[] | null = null;
	if (r.atBound !== null && r.atBound !== undefined) {
		if (!Array.isArray(r.atBound) || !r.atBound.every((b) => (AT_BOUND_VALUES as readonly unknown[]).includes(b))) return `${id}: atBound is not a list of x1:low, x4:high and the like`;
		atBound = [...new Set(r.atBound as AtBound[])].sort();
	}
	return { id, lon, lat, areaKm2, attributes, dorPct, pawcMm, flowYears, params, kgeFit, kgeValidation, atBound };
}

/** The file's flow-space leave-one-out score; null when absent or not a valid one. */
export function looFlowFromJson(raw: unknown): LooFlowScore | null {
	const r = raw as Record<string, unknown> | null | undefined;
	if (!r || typeof r !== 'object') return null;
	const kge = num(r.kge);
	const kgeFit = num(r.kgeFit);
	const n = num(r.n);
	return kge !== null && kge <= 1 && kgeFit !== null && kgeFit <= 1 && n !== null && Number.isInteger(n) && n >= 3 ? { kge, kgeFit, n } : null;
}

/** The donor file, or why it isn't one. A bad donor is a problem, never stored; a repeated id too. */
export function donorsFromJson(doc: unknown): { meta: Partial<Omit<DonorSetMeta, 'dataset'>>; donors: DonorRecord[]; problems: string[] } | string {
	const d = doc as Record<string, unknown> | null;
	if (d?.kind !== 'gr4j-donors') return 'the JSON file has no "kind" of "gr4j-donors" (the donor file fit-donors.ts writes)';
	if (!Array.isArray(d.donors)) return 'the JSON file has no "donors"';
	const ver = text(d.engineVersion, 20);
	const meta = {
		source: text(d.source, 500),
		version: text(d.version, 100),
		method: text(d.method, 1000),
		attribution: text(d.attribution, 500),
		engineVersion: ver && /^\d+\.\d+\.\d+$/.test(ver) ? ver : undefined,
		looFlow: looFlowFromJson(d.looFlow)
	};
	const donors: DonorRecord[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	d.donors.forEach((raw, i) => {
		const got = donorFromJson(raw);
		if (typeof got === 'string') return problems.push(`donor ${i + 1}: ${got}`);
		if (seen.has(got.id)) return problems.push(`donor ${i + 1}: ${got.id} twice`);
		seen.add(got.id);
		donors.push(got);
	});
	return { meta, donors, problems };
}

/** A donor set in the JSON form donorsFromJson reads. */
export function donorsToJson(meta: Omit<DonorSetMeta, 'dataset'>, donors: readonly DonorRecord[]): string {
	return JSON.stringify({ kind: 'gr4j-donors', ...meta, donors }, null, 1);
}

const BATCH = 1_000;

/** Replace `meta.dataset` with `donors`, in one transaction, as the schema owner; returns how many it wrote. */
export async function replaceDonorDataset(client: pg.ClientBase, meta: DonorSetMeta, donors: readonly DonorRecord[], origin: ReferenceOrigin | null = null): Promise<number> {
	if (!donors.length) throw new Error('no donor to load');
	await client.query('BEGIN');
	try {
		await client.query('DELETE FROM gr4j_donor_dataset WHERE dataset = $1', [meta.dataset]);
		await client.query(
			`INSERT INTO gr4j_donor_dataset (dataset, source, version, method, attribution, engine_version, donor_set_sha256, loo_flow_kge, loo_flow_kge_fit, loo_flow_n)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			[meta.dataset, meta.source, meta.version, meta.method, meta.attribution, meta.engineVersion, donorSetSha256(donors), meta.looFlow?.kge ?? null, meta.looFlow?.kgeFit ?? null, meta.looFlow?.n ?? null]
		);
		for (let i = 0; i < donors.length; i += BATCH) {
			const part = donors.slice(i, i + BATCH);
			const col = <T>(f: (d: DonorRecord) => T) => part.map(f);
			await client.query(
				`INSERT INTO gr4j_donor (dataset, basin_id, lon, lat, area_km2, aridity, map_mm, slope_deg, clay_pct, sand_pct, forest_pct,
				   dor_pct, pawc_mm, flow_years, x1, x2, x3, x4, kge_fit, kge_validation, at_bound)
				 SELECT $1, t.basin_id, t.lon, t.lat, t.area_km2, t.aridity, t.map_mm, t.slope_deg, t.clay_pct, t.sand_pct, t.forest_pct, t.dor_pct, t.pawc_mm,
				   t.flow_years, t.x1, t.x2, t.x3, t.x4, t.kge_fit, t.kge_validation,
				   -- unnest can't carry an array per row: at_bound travels as JSON text (null: not recorded).
				   CASE WHEN t.at_bound IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(t.at_bound::jsonb)) END
				 FROM unnest($2::text[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::float8[],
				   $10::float8[], $11::float8[], $12::float8[], $13::float8[], $14::float8[], $15::float8[], $16::float8[], $17::float8[], $18::float8[],
				   $19::float8[], $20::float8[], $21::text[])
				   AS t(basin_id, lon, lat, area_km2, aridity, map_mm, slope_deg, clay_pct, sand_pct, forest_pct, dor_pct, pawc_mm, flow_years,
				        x1, x2, x3, x4, kge_fit, kge_validation, at_bound)`,
				[
					meta.dataset,
					col((d) => d.id),
					col((d) => d.lon),
					col((d) => d.lat),
					col((d) => d.areaKm2),
					col((d) => d.attributes.aridity),
					col((d) => d.attributes.mapMm),
					col((d) => d.attributes.slopeDeg),
					col((d) => d.attributes.clayPct),
					col((d) => d.attributes.sandPct),
					col((d) => d.attributes.forestPct),
					col((d) => d.dorPct),
					col((d) => d.pawcMm),
					col((d) => d.flowYears),
					col((d) => d.params.x1),
					col((d) => d.params.x2),
					col((d) => d.params.x3),
					col((d) => d.params.x4),
					col((d) => d.kgeFit),
					col((d) => d.kgeValidation),
					col((d) => (d.atBound === null ? null : JSON.stringify(d.atBound)))
				]
			);
		}
		await recordReferenceOrigin(client, 'gr4j-donors', meta.dataset, origin);
		await client.query('COMMIT');
		return donors.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}

export interface DonorDataset extends DonorSetMeta {
	looFlow: LooFlowScore | null;
	donorSetSha256: string;
	donors: number;
	loadedAt: string;
	synthetic: boolean;
}

/** The loaded donor sets, the default first: a real one before the synthetic set, then the newest load. */
export async function donorDatasets(db: Db | pg.ClientBase): Promise<DonorDataset[]> {
	const { rows } = await db.query<{
		dataset: string;
		source: string;
		version: string;
		method: string;
		attribution: string;
		engine_version: string;
		donor_set_sha256: string;
		loaded_at: Date;
		donors: number;
		loo_flow_kge: number | null;
		loo_flow_kge_fit: number | null;
		loo_flow_n: number | null;
	}>(
		`SELECT d.dataset, d.source, d.version, d.method, d.attribution, d.engine_version, d.donor_set_sha256, d.loaded_at,
		        d.loo_flow_kge, d.loo_flow_kge_fit, d.loo_flow_n,
		        (SELECT count(*)::int FROM gr4j_donor g WHERE g.dataset = d.dataset) AS donors
		 FROM gr4j_donor_dataset d ORDER BY d.dataset = $1, d.loaded_at DESC, d.dataset`,
		[SYNTHETIC_DONOR_DATASET]
	);
	return rows.map((r) => ({
		dataset: r.dataset,
		source: r.source,
		version: r.version,
		method: r.method,
		attribution: r.attribution,
		engineVersion: r.engine_version,
		looFlow: r.loo_flow_kge !== null && r.loo_flow_kge_fit !== null && r.loo_flow_n !== null ? { kge: r.loo_flow_kge, kgeFit: r.loo_flow_kge_fit, n: r.loo_flow_n } : null,
		donorSetSha256: r.donor_set_sha256,
		donors: r.donors,
		loadedAt: r.loaded_at.toISOString(),
		synthetic: r.dataset === SYNTHETIC_DONOR_DATASET
	}));
}

/** One dataset's donors, by id. */
export async function readDonors(db: Db | pg.ClientBase, dataset: string): Promise<DonorRecord[]> {
	const { rows } = await db.query<Record<string, number | string | string[] | null>>(
		`SELECT basin_id, lon, lat, area_km2, aridity, map_mm, slope_deg, clay_pct, sand_pct, forest_pct, dor_pct, pawc_mm, flow_years,
		        x1, x2, x3, x4, kge_fit, kge_validation, at_bound
		 FROM gr4j_donor WHERE dataset = $1 ORDER BY basin_id COLLATE "C"`,
		[dataset]
	);
	return rows.map((r) => ({
		id: r.basin_id as string,
		lon: r.lon as number,
		lat: r.lat as number,
		areaKm2: r.area_km2 as number,
		attributes: {
			aridity: r.aridity as number | null,
			mapMm: r.map_mm as number | null,
			slopeDeg: r.slope_deg as number | null,
			clayPct: r.clay_pct as number | null,
			sandPct: r.sand_pct as number | null,
			forestPct: r.forest_pct as number | null
		},
		dorPct: r.dor_pct as number,
		pawcMm: r.pawc_mm as number | null,
		flowYears: r.flow_years as number,
		params: { x1: r.x1 as number, x2: r.x2 as number, x3: r.x3 as number, x4: r.x4 as number },
		kgeFit: r.kge_fit as number,
		kgeValidation: r.kge_validation as number | null,
		atBound: r.at_bound as AtBound[] | null
	}));
}
