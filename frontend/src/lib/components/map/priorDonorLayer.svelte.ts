// The Prior donors layer's state on the Map tab (issue #622; docs/maps.md
// § Prior donors): while `layers=donors` is in the URL, the regional GR4J
// prior for the target the URL names (`priorZone=`, priorLinks.ts: a zone, the
// outlet's own zone, else the headline) is asked for (GET …/gr4j-prior, the
// route the Calibration page's Regional prior panel reads) once per project,
// per target and per change of what places the target (the catchment boundary or a gauge drawn
// again), and its kept donors handed to the map (priorDonors.ts). The request
// comes in with the deps (MapTab passes api.gr4jPrior.get), so the tests need
// no API client.
import { untrack } from 'svelte';
import type { Gr4jPrior, MapFeature } from '#lib/api/types.js';
import { donorView, type DonorView } from './priorDonors';

export interface PriorDonorLayerDeps {
	projectId: () => string;
	on: () => boolean;
	features: () => readonly MapFeature[];
	/** The target the URL names (`priorZone=`): a calibration zone's node id, `outlet`, or null for the headline. */
	zone: () => string | null;
	/** GET …/gr4j-prior for that target. */
	load: (projectId: string, zone: string | null) => Promise<Gr4jPrior>;
}

/** What places the prior's target: the boundary's and the gauges' ids and edits, so redrawing either asks again. */
export const placingKey = (features: readonly MapFeature[]) =>
	features
		.filter((f) => f.kind === 'catchment_boundary' || f.kind === 'gauge')
		.map((f) => `${f.id}@${f.updatedAt}`)
		.sort()
		.join(',');

export class PriorDonorLayer {
	#deps: PriorDonorLayerDeps;
	answer = $state.raw<Gr4jPrior | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	#asked = '';

	constructor(deps: PriorDonorLayerDeps) {
		this.#deps = deps;
		$effect(() => {
			const on = this.#deps.on();
			const key = on ? this.#key() : '';
			untrack(() => {
				if (!on || key === this.#asked) return;
				this.#asked = key;
				void this.#load(this.#deps.projectId(), this.#deps.zone(), key);
			});
		});
	}

	#key() {
		return `${this.#deps.projectId()}|${this.#deps.zone() ?? ''}|${placingKey(this.#deps.features())}`;
	}

	/** The request the answer is for (project, target, placing): the map frames the donors once per new one. */
	get asked() {
		return this.#asked;
	}

	/** Whether the layer is on (the URL says so). */
	get on() {
		return this.#deps.on();
	}

	/** What the map draws and the Layers box lists; null while off, loading or failed. */
	get view(): DonorView | null {
		return this.on && this.answer && !this.error ? donorView(this.answer) : null;
	}

	async #load(id: string, zone: string | null, key: string) {
		this.loading = true;
		this.error = null;
		try {
			const a = await this.#deps.load(id, zone);
			if (key === this.#asked) this.answer = a;
		} catch (e) {
			if (key === this.#asked) {
				this.error = e instanceof Error ? e.message : String(e);
				this.#asked = '';
			}
		} finally {
			if (key === this.#asked || !this.#asked) this.loading = false;
		}
	}

	/** Ask again (after an error). */
	retry() {
		this.#asked = this.#key();
		void this.#load(this.#deps.projectId(), this.#deps.zone(), this.#asked);
	}
}
