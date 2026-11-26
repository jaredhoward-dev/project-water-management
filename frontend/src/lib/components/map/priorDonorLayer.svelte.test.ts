// The Prior donors layer's state (priorDonorLayer.svelte.ts, issue #622):
// asked once per project and per redraw of what places the target while on,
// never while off, an error kept until Retry. The request is the deps' `load`,
// so the test needs no API client.
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Gr4jPrior, MapFeature } from '#lib/api/types.js';
import { PriorDonorLayer, placingKey } from './priorDonorLayer.svelte';
import { deferred, square } from './layerTesting';

const answer = (ids: string[] = ['A']): Gr4jPrior =>
	({
		dataset: { dataset: 'synthetic', version: 'v1', source: 'Invented', method: 'GR4J', attribution: '', synthetic: true, donorSetSha256: '', donors: 3 },
		datasets: [],
		soil: null,
		target: { zoneNodeId: null, units: null, lon: 20, lat: -34, positionFrom: 'boundary' },
		prior: null,
		problem: null,
		donors: ids.map((id) => ({ id, lon: 19, lat: -33, areaKm2: 100, weight: 1 / ids.length, distanceKm: 10, similarity: null, kgeFit: 0.6, kgeValidation: null, params: { x1: 1, x2: 0, x3: 1, x4: 1 } })),
		ranges: null,
		provenance: null,
		started: null
	}) as unknown as Gr4jPrior;

const withEdit = (f: MapFeature, updatedAt: string) => ({ ...f, updatedAt }) as MapFeature;

let cleanup: (() => void) | null = null;
afterEach(() => {
	cleanup?.();
	cleanup = null;
});

type Load = (id: string, zone: string | null) => Promise<Gr4jPrior>;

function setup(load: Load) {
	const deps = $state({ on: false, features: [withEdit(square('b', 20, -34), 't1')] as MapFeature[], projectId: 'p1', zone: null as string | null });
	let layer!: PriorDonorLayer;
	cleanup = $effect.root(() => {
		layer = new PriorDonorLayer({ projectId: () => deps.projectId, on: () => deps.on, features: () => deps.features, zone: () => deps.zone, load });
	});
	flushSync();
	return { deps, layer };
}

describe('PriorDonorLayer', () => {
	it('asks nothing while off, and draws nothing', () => {
		const load = vi.fn<Load>(async () => answer());
		const { layer } = setup(load);
		expect(layer.on).toBe(false);
		expect(layer.view).toBeNull();
		expect(load).not.toHaveBeenCalled();
	});

	it('asks once while on, and draws the donors it was given', async () => {
		const load = vi.fn<Load>(async () => answer(['A', 'B']));
		const { deps, layer } = setup(load);
		deps.on = true;
		flushSync();
		expect(layer.loading).toBe(true);
		await vi.waitFor(() => expect(layer.view?.kind).toBe('donors'));
		expect(load).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledWith('p1', null);
		expect(layer.loading).toBe(false);
		// Off and on again: the same target, no second request.
		deps.on = false;
		flushSync();
		expect(layer.view).toBeNull();
		deps.on = true;
		flushSync();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('asks again when the boundary is redrawn, and keeps only the newest answer', async () => {
		const first = deferred<Gr4jPrior>();
		const second = deferred<Gr4jPrior>();
		const load = vi.fn<Load>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const { deps, layer } = setup(load);
		deps.on = true;
		flushSync();
		deps.features = [withEdit(square('b', 20, -34), 't2')];
		flushSync();
		expect(load).toHaveBeenCalledTimes(2);
		second.resolve(answer(['new']));
		await vi.waitFor(() => expect(layer.view?.kind === 'donors' && layer.view.donors[0]!.id).toBe('new'));
		first.resolve(answer(['old']));
		await Promise.resolve();
		expect(layer.view?.kind === 'donors' && layer.view.donors[0]!.id).toBe('new');
	});

	it('asks for the target the URL names, and again when it changes', async () => {
		const load = vi.fn<Load>(async () => answer());
		const { deps, layer } = setup(load);
		deps.zone = 'n7';
		deps.on = true;
		flushSync();
		await vi.waitFor(() => expect(layer.view?.kind).toBe('donors'));
		expect(load).toHaveBeenLastCalledWith('p1', 'n7');
		const asked = layer.asked;
		deps.zone = 'outlet';
		flushSync();
		expect(load).toHaveBeenLastCalledWith('p1', 'outlet');
		expect(layer.asked).not.toBe(asked);
	});

	it('keeps an error until Try again, which asks again', async () => {
		const load = vi.fn<Load>().mockRejectedValueOnce(new Error('Server error')).mockResolvedValueOnce(answer());
		const { deps, layer } = setup(load);
		deps.on = true;
		flushSync();
		await vi.waitFor(() => expect(layer.error).toBe('Server error'));
		expect(layer.view).toBeNull();
		expect(layer.loading).toBe(false);
		layer.retry();
		await vi.waitFor(() => expect(layer.view?.kind).toBe('donors'));
		expect(layer.error).toBeNull();
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('keys on the boundary and gauges only, in any order', () => {
		const b = withEdit(square('b', 20, -34), 't1');
		const g = withEdit(square('g', 20, -34, 'gauge'), 't1');
		const p = withEdit(square('p', 20, -34, 'farm_parcel'), 't1');
		expect(placingKey([b, g, p])).toBe(placingKey([g, b]));
		expect(placingKey([b])).not.toBe(placingKey([withEdit(b, 't2')]));
	});
});
