// A polygon's outline as a hash (followups F7, docs/maps.md § Checks): what
// the stamps of a value read over a polygon record beside its area, so a
// redraw to the same area is told apart from a rename or a relink (both of
// which bump updated_at and keep the outline). Served on every polygon
// feature (GET …/map/features `geomHash`), recorded in each stamp
// (acceptances.ts PolygonStamp, a unit feed's `unit` mark, the WR2012
// reference's lookup) and compared before the area when both sides have one.
//
// The hash is of the outline, not of how its GeoJSON happens to be written.
// Normalised first, so the same shape always gives the same hash:
//  * every coordinate rounded to 1e-7° (about 1 cm), as integers;
//  * each ring opened (the closing vertex dropped) and repeated vertices in a
//    row dropped (after rounding, the wrap included); a ring left with fewer
//    than 3 vertices is dropped;
//  * outer rings anticlockwise and holes clockwise (RFC 7946's winding);
//  * each ring started at its least vertex (by longitude, then latitude; the
//    least rotation among ties);
//  * a polygon's holes sorted, and a MultiPolygon's polygons sorted, so a
//    Polygon and a one-part MultiPolygon of the same rings hash alike.
// Then SHA-256 over the canonical text, its first 32 hex digits (128 bits).
// Changing any of this changes every hash, which every stored stamp would
// read as a redraw: a new normalisation needs a new field name, never a new
// meaning for this one.
import { createHash } from 'node:crypto';
import type { Geometry, Position } from './geojson.js';

/** Coordinates are compared to this many decimal places of a degree (1e-7°, about 1 cm). */
export const HASH_DECIMALS = 7;
const SCALE = 10 ** HASH_DECIMALS;

type Pt = [number, number];

const cmp = (a: Pt, b: Pt) => a[0] - b[0] || a[1] - b[1];

function ringOf(raw: readonly Position[]): Pt[] {
	const pts: Pt[] = [];
	for (const p of raw) {
		const q: Pt = [Math.round(p[0] * SCALE), Math.round(p[1] * SCALE)];
		const last = pts[pts.length - 1];
		if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
	}
	// Open it: the closing vertex (and any repeat of the first at the end) goes.
	while (pts.length > 1 && pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1]) pts.pop();
	return pts;
}

/** Twice the signed area (anticlockwise > 0), relative to the first vertex so the products stay exact in a double. */
function signedArea2(r: readonly Pt[]): number {
	const [x0, y0] = r[0]!;
	let s = 0;
	for (let i = 0; i < r.length; i++) {
		const a = r[i]!;
		const b = r[(i + 1) % r.length]!;
		s += (a[0] - x0) * (b[1] - y0) - (b[0] - x0) * (a[1] - y0);
	}
	return s;
}

/** The ring wound as asked, started at its least vertex (the least rotation among ties), as text. */
function canonicalRing(r: Pt[], anticlockwise: boolean): string {
	if (signedArea2(r) > 0 !== anticlockwise) r = r.slice().reverse();
	let best: string | null = null;
	let least: Pt | null = null;
	for (const p of r) if (!least || cmp(p, least) < 0) least = p;
	for (let i = 0; i < r.length; i++) {
		if (cmp(r[i]!, least!) !== 0) continue;
		const text = [...r.slice(i), ...r.slice(0, i)].map((p) => `${p[0]},${p[1]}`).join(' ');
		if (best === null || text < best) best = text;
	}
	return best!;
}

function canonicalPolygon(rings: readonly (readonly Position[])[]): string | null {
	const [outer, ...holes] = rings.map(ringOf);
	if (!outer || outer.length < 3) return null;
	const hs = holes
		.filter((h) => h.length >= 3)
		.map((h) => canonicalRing(h, false))
		.sort();
	return [canonicalRing(outer, true), ...hs].join('|');
}

/**
 * The outline's hash: 32 hex digits, the same for any writing of the same shape (see the file's header). null for
 * anything but a Polygon or MultiPolygon, and for one with no ring of 3 distinct vertices left.
 */
export function geometryHash(g: Geometry | null | undefined): string | null {
	if (!g) return null;
	const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
	if (!polys) return null;
	const parts = polys.map(canonicalPolygon).filter((p): p is string => p !== null);
	if (!parts.length) return null;
	parts.sort();
	return createHash('sha256').update(parts.join('/')).digest('hex').slice(0, 32);
}
