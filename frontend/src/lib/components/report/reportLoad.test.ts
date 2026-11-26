// The report page's load (reportLoad.ts), latest wins (issue #859): with ?run=
// changed while the first run's load is still out, that slower first load
// must not land over the run the address now names, nor its failure.
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import type { Project, Run } from '#lib/api/types.js';
import { reportLoader, type ReportLoadDeps } from './reportLoad';

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

const project = { id: 'p1', name: 'Catchment' } as unknown as Project;
const runOf = (id: string) => ({ id }) as unknown as Run;
const detailOf = (id: string) => ({ run: runOf(id), series: [] });

/** A fake API whose run reads answer only when the test says, so two loads can come back out of order. */
function fakeDeps() {
	const runReads = new Map<string, ReturnType<typeof deferred<ReturnType<typeof detailOf>>>>();
	const read = (runId: string) => {
		let d = runReads.get(runId);
		if (!d) runReads.set(runId, (d = deferred()));
		return d;
	};
	const deps = {
		api: {
			projects: { get: vi.fn(async () => project) },
			runs: {
				list: vi.fn(async () => []),
				get: vi.fn((_id: string, runId: string) => read(runId).promise),
				series: vi.fn()
			},
			series: { list: vi.fn(async () => []) },
			signoffs: { list: vi.fn(async () => ({ signoffs: [] })) },
			publication: { ofRun: vi.fn(async () => ({ publication: null, previous: null })) },
			compare: { runs: vi.fn() }
		},
		chunks: async () => undefined
	} as unknown as ReportLoadDeps;
	return { deps, read };
}

describe('reportLoader', () => {
	it('answers a load of the run in the address with that run', async () => {
		const { deps, read } = fakeDeps();
		const load = reportLoader(deps);
		const a = load('p1', 'run-a', null);
		read('run-a').resolve(detailOf('run-a'));
		const r = await a;
		expect(r.current && r.value.status === 'loaded' && r.value.run.id).toBe('run-a');
	});

	it("never lets a slower load of the previous ?run= land over the later run's report", async () => {
		const { deps, read } = fakeDeps();
		const load = reportLoader(deps);
		const first = load('p1', 'run-a', null);
		const second = load('p1', 'run-b', null);
		// The second run answers first; the first run's answer comes in after it.
		read('run-b').resolve(detailOf('run-b'));
		const b = await second;
		read('run-a').resolve(detailOf('run-a'));
		const a = await first;
		// Positive control: the latest load is applied, with the run the address names.
		expect(b.current && b.value.status === 'loaded' && b.value.run.id).toBe('run-b');
		expect(a).toEqual({ current: false });
	});

	it("drops a superseded load's failure and throws the latest one's", async () => {
		const { deps, read } = fakeDeps();
		const load = reportLoader(deps);
		const first = load('p1', 'run-a', null);
		const second = load('p1', 'run-b', null);
		const firstDone = expect(first).resolves.toEqual({ current: false });
		const secondDone = expect(second).rejects.toThrow('later boom');
		read('run-a').reject(new ApiError(500, 'boom'));
		read('run-b').reject(new ApiError(500, 'later boom'));
		await firstDone;
		await secondDone;
	});

	it("drops a superseded load's not-found run, keeping the later run", async () => {
		const { deps, read } = fakeDeps();
		const load = reportLoader(deps);
		const first = load('p1', 'gone', null);
		const second = load('p1', 'run-b', null);
		read('run-b').resolve(detailOf('run-b'));
		await second;
		read('gone').reject(new ApiError(404, 'Not found'));
		await expect(first).resolves.toEqual({ current: false });
	});
});
