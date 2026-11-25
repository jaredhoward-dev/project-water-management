// What each value accepted from the map was taken over (issue #646 item 4,
// the hydrologist's review F7 and F8; docs/maps.md § Checks): the polygon a
// unit's MAP, its rain feed's cells and a planted area from land cover were
// read over, and the boundary an evaporation row was summarised over, each as
// it stood then (`{ featureId, updatedAt, areaM2, geomHash }`, 273_acceptance_polygons;
// the hash since followups F7, geomHash.ts).
// GET …/map/features returns them beside the features, so the Map's Checks
// and the Start data list can say that a value was taken over an outline
// redrawn since (frontend map/stale.ts). Read-only, under the caller's RLS
// (viewer: the same tables the Settings and Crops panels show).
import type { Db } from '../db/tx.js';
import type { Geometry } from './geojson.js';
import { geometryHash } from './geomHash.js';

/** A polygon as it stood when a value was read over it. */
export interface PolygonStamp {
	featureId: string;
	updatedAt: string;
	areaM2: number;
	/** Its outline's hash (geomHash.ts), recorded since followups F7; absent in a stamp from before. */
	geomHash?: string;
}

/** Two areas of one polygon within this (m²) are one outline: a rename or relink bumps updated_at but not the area. */
export const OUTLINE_SLACK_M2 = 0.5;

/**
 * Whether the polygon a value was read over is another outline now: another feature, or the same one with another
 * outline. When both sides carry the outline's hash (geomHash.ts, followups F7), the hashes decide: a reshape to the
 * same area is a change, a rename or a relink (which bump updated_at) isn't. A stamp from before the hash falls back
 * to the area rule: edited since with another area (a redraw to the same area then goes unseen, as it always did).
 * The frontend's map/stale.ts holds the same rule.
 */
export const outlineChanged = (then: PolygonStamp, now: PolygonStamp): boolean => {
	if (then.featureId !== now.featureId) return true;
	if (then.geomHash && now.geomHash) return then.geomHash !== now.geomHash;
	return then.updatedAt !== now.updatedAt && Math.abs(then.areaM2 - now.areaM2) > OUTLINE_SLACK_M2;
};

/** A polygon's stamp as it stands now, its outline's hash with it (none when the geometry isn't a polygon). */
export function polygonStamp(f: { id: string; updatedAt: string; areaM2: number | null; geometry: Geometry }): PolygonStamp {
	const geomHash = geometryHash(f.geometry);
	return { featureId: f.id, updatedAt: f.updatedAt, areaM2: f.areaM2 ?? 0, ...(geomHash ? { geomHash } : {}) };
}

export interface MapAcceptances {
	/** Each unit whose MAP came from the grid since 273: the polygon it was taken over. */
	unitMap: { nodeId: string; polygon: PolygonStamp }[];
	/** Each unit's own CHIRPS feed (its config's `unit` mark, feeds/fromUnits.ts): the polygon its cells came from. */
	unitRain: { nodeId: string; featureId: string; updatedAt: string; areaKm2: number; geomHash?: string }[];
	/** Each planted area accepted from land cover since 273: the crop and the polygons summed. */
	landCover: { nodeId: string; cropId: string; cropName: string; polygons: PolygonStamp[] }[];
	/** Each evaporation row accepted from the map: its target and the boundary it was summarised over (null before 273). */
	evaporation: { target: 'pe' | 'apan'; boundary: PolygonStamp | null }[];
}

/** The project's acceptances from the map, each with what it was taken over. */
export async function mapAcceptances(db: Db, projectId: string): Promise<MapAcceptances> {
	// One after another: the transaction's client runs one query at a time.
	const unitMap = await db.query<{ nodeId: string; polygon: PolygonStamp }>(
		`SELECT id AS "nodeId", map_polygon AS polygon FROM node WHERE project_id = $1 AND map_polygon IS NOT NULL ORDER BY sort_order, id`,
		[projectId]
	);
	const unitRain = await db.query<{ nodeId: string; featureId: string; updatedAt: string; areaKm2: number; geomHash: string | null }>(
		`SELECT config -> 'unit' ->> 'nodeId' AS "nodeId", config -> 'unit' ->> 'featureId' AS "featureId",
			config -> 'unit' ->> 'updatedAt' AS "updatedAt", (config -> 'unit' ->> 'areaKm2')::float8 AS "areaKm2",
			config -> 'unit' ->> 'geomHash' AS "geomHash"
		 FROM data_feed WHERE project_id = $1 AND source = 'chirps' AND jsonb_typeof(config -> 'unit') = 'object'
		 ORDER BY created_at, id`,
		[projectId]
	);
	const landCover = await db.query<{ nodeId: string; cropId: string; cropName: string; polygons: PolygonStamp[] }>(
		`SELECT p.node_id AS "nodeId", p.crop_id AS "cropId", c.name AS "cropName", p.polygons
		 FROM crop_area_land_cover p JOIN crop c ON c.id = p.crop_id
		 WHERE p.project_id = $1 AND p.polygons IS NOT NULL ORDER BY p.node_id, c.name, p.crop_id`,
		[projectId]
	);
	const evaporation = await db.query<{ target: 'pe' | 'apan'; boundary: PolygonStamp | null }>(
		`SELECT target, boundary FROM evaporation_accepted WHERE project_id = $1 ORDER BY target`,
		[projectId]
	);
	return {
		unitMap: unitMap.rows,
		// A mark the feed config check let through always has all four; one that doesn't is skipped, not guessed.
		// A mark from before the hash (followups F7) has none: the key is left out, not null.
		unitRain: unitRain.rows
			.filter((r) => r.nodeId && r.featureId && r.updatedAt && Number.isFinite(r.areaKm2))
			.map(({ geomHash, ...r }) => (geomHash ? { ...r, geomHash } : r)),
		landCover: landCover.rows,
		evaporation: evaporation.rows
	};
}
