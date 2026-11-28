// Property-style invariants of the routing core (flow.ts) and the division of a
// catchment among units (subcatchments.ts partition), over seeded random grids:
// elevations on a few levels (so most of the grid is flats and pits), holes of
// no data, and random outlets and unit cells. The hand-made grids in
// flow.test.ts and subcatchments.test.ts pin particular answers; these pin what
// must hold on any grid:
//  - routing: fill never lowers a cell, every cell's D8 path ends at an edge
//    without a cycle or a step into no data, and the edge cells' accumulation
//    is the whole grid;
//  - accumulation is the size of each cell's catchment;
//  - a division: the pieces and the outlet's rest cover the catchment exactly
//    once, a unit's whole catchment (its piece and every unit draining into it)
//    is exactly the land above its cell, and a unit's catchment lies inside,
//    and is smaller than, the catchment of the unit it drains into.
import { describe, expect, it } from 'vitest';
import { accumulate, d8, DX, DY, edgeMask, fill, OUT, upstream, type Grid } from './flow.js';
import { partition } from './subcatchments.js';

/** mulberry32: a small seeded generator, so a failing case names its seed. */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A random grid: a tilted plane plus noise on `levels` steps (flats everywhere), with a share of no-data cells. */
function randomGrid(r: () => number): Grid {
	const nx = 6 + Math.floor(r() * 26);
	const ny = 6 + Math.floor(r() * 26);
	const levels = 1 + Math.floor(r() * 4);
	const tilt = r() < 0.3 ? 0 : r() * 0.3;
	const holes = r() < 0.5 ? 0 : r() * 0.08;
	const z = new Float64Array(nx * ny);
	for (let y = 0; y < ny; y++) {
		for (let x = 0; x < nx; x++) {
			z[y * nx + x] = r() < holes ? Number.NaN : Math.floor(r() * levels) + Math.floor(tilt * y);
		}
	}
	return { nx, ny, z };
}

const next = (nx: number, dir: Uint8Array, c: number) => (dir[c] === OUT ? -1 : c + DY[dir[c]!]! * nx + DX[dir[c]!]!);
const count = (mask: Uint8Array) => mask.reduce((s, v) => s + v, 0);

const SEEDS = 60;

describe('routing on random grids (seeded)', () => {
	it('fill never lowers a cell nor fills no data, and leaves every inner cell a strictly lower neighbour', () => {
		for (let seed = 1; seed <= SEEDS; seed++) {
			const g = randomGrid(rng(seed));
			const before = Float64Array.from(g.z);
			const edge = edgeMask(g);
			fill(g, edge);
			const dir = d8(g, edge);
			for (let i = 0; i < g.z.length; i++) {
				if (Number.isNaN(before[i]!)) expect(Number.isNaN(g.z[i]!), `seed ${seed} cell ${i}`).toBe(true);
				else expect(g.z[i]!, `seed ${seed} cell ${i}`).toBeGreaterThanOrEqual(before[i]!);
				// An edge drains out of the grid; every other cell has somewhere strictly lower to go.
				expect(dir[i] === OUT, `seed ${seed} cell ${i}`).toBe(edge[i] !== 0);
				const k = next(g.nx, dir, i);
				if (k >= 0) expect(g.z[k]!, `seed ${seed} cell ${i}`).toBeLessThan(g.z[i]!);
			}
		}
	});

	it('drains every cell to an edge, never through no data and never round a cycle, and the edges hold the whole grid', () => {
		for (let seed = 1; seed <= SEEDS; seed++) {
			const g = randomGrid(rng(seed));
			const edge = edgeMask(g);
			const raw = Float64Array.from(g.z);
			fill(g, edge);
			const dir = d8(g, edge);
			const n = g.nx * g.ny;
			for (let i = 0; i < n; i++) {
				let c = i;
				for (let steps = 0; dir[c] !== OUT; steps++) {
					expect(steps, `seed ${seed}: cell ${i} goes round a cycle`).toBeLessThan(n);
					c = next(g.nx, dir, c);
					expect(Number.isNaN(raw[c]!), `seed ${seed}: cell ${i} drains into no data`).toBe(false);
				}
				expect(edge[c], `seed ${seed}: cell ${i} ends off an edge`).not.toBe(0);
			}
			const acc = accumulate(g.nx, g.ny, dir);
			let atEdges = 0;
			for (let i = 0; i < n; i++) if (dir[i] === OUT) atEdges += acc[i]!;
			expect(atEdges, `seed ${seed}`).toBe(n);
		}
	});

	it('accumulates each cell’s catchment: acc is the count of cells whose path passes it', () => {
		for (let seed = 1; seed <= SEEDS; seed++) {
			const r = rng(seed);
			const g = randomGrid(r);
			const edge = edgeMask(g);
			fill(g, edge);
			const dir = d8(g, edge);
			const acc = accumulate(g.nx, g.ny, dir);
			for (let s = 0; s < 10; s++) {
				const c = Math.floor(r() * g.nx * g.ny);
				expect(acc[c], `seed ${seed} cell ${c}`).toBe(count(upstream(g.nx, g.ny, dir, c)));
			}
		}
	});
});

describe('partition on random grids (seeded)', () => {
	/** A routed random grid with an outlet whose catchment has room for units, or null when the grid has none. */
	function divided(seed: number) {
		const r = rng(seed);
		const g = randomGrid(r);
		const edge = edgeMask(g);
		fill(g, edge);
		const dir = d8(g, edge);
		const acc = accumulate(g.nx, g.ny, dir);
		const n = g.nx * g.ny;
		// The outlet: the largest inner catchment, so the division has cells to share.
		let outlet = -1;
		for (let i = 0; i < n; i++) if (!edge[i] && (outlet < 0 || acc[i]! > acc[outlet]!)) outlet = i;
		if (outlet < 0 || acc[outlet]! < 4) return null;
		const above = upstream(g.nx, g.ny, dir, outlet);
		const candidates: number[] = [];
		for (let i = 0; i < n; i++) if (above[i] && i !== outlet) candidates.push(i);
		const k = 1 + Math.floor(r() * Math.min(6, candidates.length));
		const units: { cell: number; owns: boolean }[] = [];
		while (units.length < k) {
			const c = candidates.splice(Math.floor(r() * candidates.length), 1)[0]!;
			units.push({ cell: c, owns: r() < 0.75 });
		}
		return { g, dir, acc, outlet, above, units, p: partition(g.nx, g.ny, dir, outlet, units) };
	}

	it('gives every cell of the catchment exactly one owner, and none outside it; a unit without land owns nothing', () => {
		let tried = 0;
		for (let seed = 1; seed <= SEEDS * 2; seed++) {
			const d = divided(seed);
			if (!d) continue;
			tried++;
			const { p, above, units, acc, outlet } = d;
			const owned = new Array(units.length + 1).fill(0);
			for (let i = 0; i < p.owner.length; i++) {
				expect(p.owner[i] !== -1, `seed ${seed} cell ${i}`).toBe(above[i] === 1);
				if (p.owner[i]! >= 0) owned[p.owner[i]!]++;
			}
			expect(owned.reduce((s, v) => s + v, 0), `seed ${seed}`).toBe(acc[outlet]);
			units.forEach((u, i) => {
				if (!u.owns) expect(owned[i], `seed ${seed} unit ${i}`).toBe(0);
				else expect(owned[i], `seed ${seed} unit ${i}`).toBeGreaterThanOrEqual(1);
			});
		}
		expect(tried).toBeGreaterThan(SEEDS);
	});

	it('links each unit to the first unit on its path down, or the outlet, without a cycle', () => {
		for (let seed = 1; seed <= SEEDS * 2; seed++) {
			const d = divided(seed);
			if (!d) continue;
			const { p, units, dir, g, outlet } = d;
			const at = new Map(units.map((u, i) => [u.cell, i]));
			units.forEach((u, i) => {
				let c = next(g.nx, dir, u.cell);
				while (c !== outlet && !at.has(c)) c = next(g.nx, dir, c);
				expect(p.down[i], `seed ${seed} unit ${i}`).toBe(c === outlet ? -1 : at.get(c));
				// Following down always reaches the outlet.
				let j = i;
				for (let hops = 0; j !== -1; hops++) {
					expect(hops, `seed ${seed}: unit ${i} goes round a cycle`).toBeLessThanOrEqual(units.length);
					j = p.down[j]!;
				}
			});
		}
	});

	it('makes a unit’s piece and the pieces of every unit draining into it exactly the land above its cell, inside and smaller than the catchment it drains into', () => {
		for (let seed = 1; seed <= SEEDS * 2; seed++) {
			const d = divided(seed);
			if (!d) continue;
			const { p, units, dir, g, acc, outlet } = d;
			/** Whether unit j drains, through any number of units, into unit i (j itself included). */
			const drainsInto = (j: number, i: number) => {
				for (let k = j; k !== -1; k = p.down[k]!) if (k === i) return true;
				return false;
			};
			units.forEach((u, i) => {
				if (!u.owns) return;
				const above = upstream(g.nx, g.ny, dir, u.cell);
				for (let c = 0; c < p.owner.length; c++) {
					const o = p.owner[c]!;
					const inWhole = o >= 0 && o < units.length && drainsInto(o, i);
					expect(inWhole, `seed ${seed} unit ${i} cell ${c}`).toBe(above[c] === 1);
				}
				const parent = p.down[i]!;
				const parentCell = parent === -1 ? outlet : units[parent]!.cell;
				expect(acc[u.cell]!, `seed ${seed} unit ${i}`).toBeLessThan(acc[parentCell]!);
				const parentAbove = upstream(g.nx, g.ny, dir, parentCell);
				for (let c = 0; c < above.length; c++) if (above[c]) expect(parentAbove[c], `seed ${seed} unit ${i} cell ${c}`).toBe(1);
			});
		}
	});
});
