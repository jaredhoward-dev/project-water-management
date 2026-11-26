// The model input the calibration panels read (issue #913): the fit panel's estimate when it opens, the automated
// calibration panel's when it opens, and the fit itself at Fit all want the project's input as the server would run
// it (GET /projects/:id/model-input), which for a large project is megabytes. One load per project and revision
// (the project's updatedAt), shared by every caller while it is in flight and kept after, so the two panels opening
// together load it once. Only the latest project's input is kept, so another project's never lingers.
// `refresh` always loads and keeps the answer: Fit uses it, since a feed can add days to a series without moving the
// project's updatedAt, and the fit must run on the input as it is now; the estimates then read that one.
// Pure: no Svelte, no API (the shared instance is ./modelInputShared.ts).
import type { ModelInput } from '@water-management/engine';

type Fetch = (projectId: string) => Promise<ModelInput>;

export class SharedModelInput {
	#fetch: Fetch;
	#key: string | null = null;
	#input: ModelInput | null = null;
	#pending: Promise<ModelInput> | null = null;

	constructor(fetch: Fetch) {
		this.#fetch = fetch;
	}

	/** The input for this project at this revision: the one held, else one load shared by every caller until it settles (a failed one is retried next time). */
	get(projectId: string, revision: string): Promise<ModelInput> {
		const key = `${projectId}@${revision}`;
		if (key === this.#key) {
			if (this.#input) return Promise.resolve(this.#input);
			if (this.#pending) return this.#pending;
		}
		return this.#load(projectId, key);
	}

	/** Load it afresh (Fit), whatever is held, and keep it for the next get at this revision. */
	refresh(projectId: string, revision: string): Promise<ModelInput> {
		return this.#load(projectId, `${projectId}@${revision}`);
	}

	#load(projectId: string, key: string): Promise<ModelInput> {
		this.#key = key;
		this.#input = null;
		const pending = this.#fetch(projectId);
		this.#pending = pending;
		pending.then(
			(input) => {
				if (this.#pending === pending) {
					this.#input = input;
					this.#pending = null;
				}
			},
			() => {
				if (this.#pending === pending) this.#pending = null;
			}
		);
		return pending;
	}
}
