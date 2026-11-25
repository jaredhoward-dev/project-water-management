// The outline hash (geomHash.ts, followups F7) and the stamp rule that reads it (acceptances.ts outlineChanged).
// Synthetic squares only.
import { describe, expect, it } from 'vitest';
import { landCoverStamps } from './croplandRoutes.js';
import { outlineChanged, polygonStamp } from './acceptances.js';
import type { Geometry, Position } from './geojson.js';
import { geometryHash } from './geomHash.js';

const ring = (pts: Position[]): Position[] => [...pts, pts[0]!];
const sq: Position[] = [
	[21, -34],
	[21.02, -34],
	[21.02, -33.98],
	[21, -33.98]
];
const poly = (...rings: Position[][]): Geometry => ({ type: 'Polygon', coordinates: rings.map(ring) });
const hole: Position[] = [
	[21.005, -33.995],
	[21.005, -33.985],
	[21.015, -33.985],
	[21.015, -33.995]
];

describe('geometryHash', () => {
	it('is 32 hex digits for a polygon, null for points, lines and empty rings', () => {
		expect(geometryHash(poly(sq))).toMatch(/^[0-9a-f]{32}$/);
		expect(geometryHash({ type: 'Point', coordinates: [21, -34] })).toBeNull();
		expect(geometryHash({ type: 'LineString', coordinates: sq })).toBeNull();
		expect(geometryHash({ type: 'Polygon', coordinates: [[[21, -34], [21, -34], [21, -34]]] })).toBeNull();
		expect(geometryHash(null)).toBeNull();
	});

	it('is the same for any start vertex, either winding, repeated vertices and noise under 1e-7°', () => {
		const h = geometryHash(poly(sq));
		expect(geometryHash(poly([...sq.slice(2), ...sq.slice(0, 2)]))).toBe(h);
		expect(geometryHash(poly([...sq].reverse()))).toBe(h);
		expect(geometryHash(poly([sq[0]!, sq[0]!, sq[1]!, sq[2]!, sq[2]!, sq[3]!]))).toBe(h);
		expect(geometryHash(poly(sq.map(([x, y]) => [x + 3e-9, y - 3e-9] as Position)))).toBe(h);
		// Unclosed rings read the same as closed ones.
		expect(geometryHash({ type: 'Polygon', coordinates: [sq] })).toBe(h);
	});

	it('is the same for a Polygon and a one-part MultiPolygon, and for parts or holes in any order', () => {
		const other = sq.map(([x, y]) => [x + 1, y] as Position);
		expect(geometryHash({ type: 'MultiPolygon', coordinates: [[ring(sq)]] })).toBe(geometryHash(poly(sq)));
		expect(geometryHash({ type: 'MultiPolygon', coordinates: [[ring(sq)], [ring(other)]] })).toBe(geometryHash({ type: 'MultiPolygon', coordinates: [[ring(other)], [ring(sq)]] }));
		const west: Position[] = [[21.002, -33.998], [21.002, -33.996], [21.004, -33.996], [21.004, -33.998]];
		const east: Position[] = [[21.016, -33.998], [21.016, -33.996], [21.018, -33.996], [21.018, -33.998]];
		expect(geometryHash(poly(sq, west, [...east].reverse()))).toBe(geometryHash(poly(sq, east, west)));
		// A hole wound either way is the same hole.
		expect(geometryHash(poly(sq, hole))).toBe(geometryHash(poly(sq, [...hole].reverse())));
	});

	it('differs for a reshape that keeps the area, and for a hole added', () => {
		// The same 0.02° × 0.02° square moved east by 0.001°: one area, another outline.
		const moved = sq.map(([x, y]) => [x + 0.001, y] as Position);
		expect(geometryHash(poly(moved))).not.toBe(geometryHash(poly(sq)));
		// A vertex moved by 1e-6° (about 10 cm) is another outline.
		expect(geometryHash(poly([[21.000001, -34], ...sq.slice(1)]))).not.toBe(geometryHash(poly(sq)));
		expect(geometryHash(poly(sq, hole))).not.toBe(geometryHash(poly(sq)));
	});
});

describe('outlineChanged with the hash (followups F7)', () => {
	const at = '2026-10-01T00:00:00.000Z';
	const later = '2026-10-05T00:00:00.000Z';
	const now = (geometry: Geometry, updatedAt = later, areaM2 = 4e6) => polygonStamp({ id: 'p', geometry, updatedAt, areaM2 });
	const then = polygonStamp({ id: 'p', geometry: poly(sq), updatedAt: at, areaM2: 4e6 });

	it('flags a reshape to the same area, keeps a rename or relink', () => {
		const moved = poly(sq.map(([x, y]) => [x + 0.001, y] as Position));
		expect(outlineChanged(then, now(moved))).toBe(true);
		expect(outlineChanged(then, now(poly(sq)))).toBe(false);
		expect(outlineChanged(then, { ...now(poly(sq)), featureId: 'q' })).toBe(true);
	});

	it('reads a stamp from before the hash by the area rule (no guessing)', () => {
		const old = { featureId: 'p', updatedAt: at, areaM2: 4e6 };
		const moved = poly(sq.map(([x, y]) => [x + 0.001, y] as Position));
		expect(outlineChanged(old, now(moved))).toBe(false);
		expect(outlineChanged(old, now(moved, later, 5e6))).toBe(true);
		expect(outlineChanged(old, now(poly(sq), at, 5e6))).toBe(false);
	});

	it('a stamp of a point carries no hash', () => {
		expect(polygonStamp({ id: 'g', geometry: { type: 'Point', coordinates: [21, -34] }, updatedAt: at, areaM2: null })).toEqual({ featureId: 'g', updatedAt: at, areaM2: 0 });
	});
});

describe('landCoverStamps', () => {
	const parcel = (i: number) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, geometry: poly(sq.map(([x, y]) => [x + i * 0.03, y] as Position)), updatedAt: '2026-10-01T00:00:00.000Z', areaM2: 4012345.678901234 });

	it('records each polygon with its hash, and none past 500 (the column’s CHECK)', () => {
		const one = JSON.parse(landCoverStamps([parcel(1)])!);
		expect(one).toEqual([{ featureId: parcel(1).id, updatedAt: parcel(1).updatedAt, areaM2: parcel(1).areaM2, geomHash: geometryHash(parcel(1).geometry) }]);
		expect(landCoverStamps(Array.from({ length: 501 }, (_, i) => parcel(i)))).toBeNull();
	});

	it('keeps 500 stamps within the column’s 100 000 bytes', () => {
		const text = landCoverStamps(Array.from({ length: 500 }, (_, i) => parcel(i)))!;
		// jsonb's text adds a space after every ':' and ','.
		const asJsonb = text.replace(/([:,])/g, '$1 ');
		expect(Buffer.byteLength(asJsonb)).toBeLessThanOrEqual(100_000);
	});
});
