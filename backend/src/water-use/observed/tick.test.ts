// The pure parts of the ET tick (tick.ts) that need no database: a unit's
// parcels as one MultiPolygon, their box, and when the cropland lookup is
// skipped without asking the database.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../db/tx.js';
import { croplandFor, parcelsBox, parcelsOf } from './tick.js';

/** A Db that records every query and answers with no rows. */
function recordingDb() {
	const calls: unknown[][] = [];
	const db = {
		query: async (_sql: string, params: unknown[]) => {
			calls.push(params);
			return { rows: [] };
		}
	} as unknown as Db;
	return { db, calls };
}

const square = (x: number, y: number, s: number) => [
	[
		[x, y],
		[x + s, y],
		[x + s, y + s],
		[x, y + s],
		[x, y]
	]
];

describe('parcelsOf and parcelsBox', () => {
	it('joins Polygons and MultiPolygons into one MultiPolygon, and boxes their outer rings', () => {
		const p = parcelsOf([
			{ type: 'Polygon', coordinates: square(21, -33, 0.01) },
			{ type: 'MultiPolygon', coordinates: [square(21.1, -33.2, 0.02)] }
		]);
		expect(p.coordinates).toHaveLength(2);
		const [w, s, e, n] = parcelsBox(p);
		expect([w, s]).toEqual([21, -33.2]);
		expect(e).toBeCloseTo(21.12, 12);
		expect(n).toBeCloseTo(-32.99, 12);
	});
});

describe('croplandFor', () => {
	it('asks the database for a unit’s box (positive control)', async () => {
		const { db, calls } = recordingDb();
		expect(await croplandFor(db, parcelsOf([{ type: 'Polygon', coordinates: square(21, -33, 0.01) }]))).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect((calls[0] as number[]).every(Number.isFinite)).toBe(true);
	});

	it('never queries with infinite bounds: no parcels, or only empty rings, have no box and no cropland', async () => {
		for (const parcels of [parcelsOf([]), { type: 'MultiPolygon' as const, coordinates: [[]] }, { type: 'MultiPolygon' as const, coordinates: [[[]]] }]) {
			const { db, calls } = recordingDb();
			expect(await croplandFor(db, parcels)).toBeUndefined();
			expect(calls).toEqual([]);
		}
	});

	it('skips a box past 1° either way without asking', async () => {
		const { db, calls } = recordingDb();
		expect(await croplandFor(db, parcelsOf([{ type: 'Polygon', coordinates: square(21, -33, 1.5) }]))).toBeUndefined();
		expect(calls).toEqual([]);
	});
});
