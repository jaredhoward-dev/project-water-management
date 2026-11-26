import { describe, expect, it } from 'vitest';
import type { ModelInput } from '@water-management/engine';
import { SharedModelInput } from './modelInput';

function fetcher() {
	const calls: { id: string; resolve: (v: ModelInput) => void; reject: (e: Error) => void }[] = [];
	const fetch = (id: string) =>
		new Promise<ModelInput>((resolve, reject) => {
			calls.push({ id, resolve, reject });
		});
	return { calls, fetch };
}
const input = (tag: string) => ({ tag }) as unknown as ModelInput;

describe('SharedModelInput (issue #913): one model-input load per project and revision', () => {
	it('shares one load between callers in flight and after it settles', async () => {
		const f = fetcher();
		const c = new SharedModelInput(f.fetch);
		const a = c.get('p', 'r1');
		const b = c.get('p', 'r1');
		expect(f.calls).toHaveLength(1);
		f.calls[0]!.resolve(input('one'));
		expect(await a).toBe(await b);
		expect(await c.get('p', 'r1')).toEqual(input('one'));
		expect(f.calls).toHaveLength(1);
	});

	it('loads again for a new revision or another project, and keeps only the latest', async () => {
		const f = fetcher();
		const c = new SharedModelInput(f.fetch);
		const first = c.get('p', 'r1');
		f.calls[0]!.resolve(input('one'));
		await first;
		const second = c.get('p', 'r2');
		expect(f.calls).toHaveLength(2);
		f.calls[1]!.resolve(input('two'));
		expect(await second).toEqual(input('two'));
		const other = c.get('q', 'r2');
		expect(f.calls.map((x) => x.id)).toEqual(['p', 'p', 'q']);
		f.calls[2]!.resolve(input('q'));
		await other;
		// Back to p at r1: not kept, loaded again.
		void c.get('p', 'r1');
		expect(f.calls).toHaveLength(4);
	});

	it('retries after a failed load', async () => {
		const f = fetcher();
		const c = new SharedModelInput(f.fetch);
		const a = c.get('p', 'r1');
		f.calls[0]!.reject(new Error('down'));
		await expect(a).rejects.toThrow('down');
		const b = c.get('p', 'r1');
		expect(f.calls).toHaveLength(2);
		f.calls[1]!.resolve(input('one'));
		expect(await b).toEqual(input('one'));
	});

	it('refresh always loads, and the next get reads what it loaded; an older load landing late is not kept', async () => {
		const f = fetcher();
		const c = new SharedModelInput(f.fetch);
		const old = c.get('p', 'r1');
		const fresh = c.refresh('p', 'r1');
		expect(f.calls).toHaveLength(2);
		f.calls[1]!.resolve(input('fresh'));
		await fresh;
		f.calls[0]!.resolve(input('old'));
		await old;
		expect(await c.get('p', 'r1')).toEqual(input('fresh'));
		expect(f.calls).toHaveLength(2);
	});
});
