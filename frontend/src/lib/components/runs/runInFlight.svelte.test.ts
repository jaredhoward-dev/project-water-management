// isFlight against a run kept in real $state (issue #923): the page and Runs & results keep the run in flight in
// $state, which holds Svelte's proxy of the object, so the code that clears it when the run ends must not compare
// with ===. It did, and a finished run stayed in flight: Run model disabled until a reload.
import { describe, expect, it } from 'vitest';
import { isFlight, type RunInFlight } from './runInFlight';

const flight = (): RunInFlight => ({ projectId: 'p', startedAt: 0, done: new Promise(() => {}) });

describe('isFlight', () => {
	it('knows the run kept in $state as the one that ended, though the kept copy is a proxy', () => {
		const started = flight();
		const page = $state<{ kept: RunInFlight | null }>({ kept: null });
		page.kept = started;
		// The trap: $state hands back a proxy, never the object itself.
		expect(page.kept === started).toBe(false);
		expect(isFlight(page.kept, started)).toBe(true);
	});
	it('leaves a newer run kept since alone, and nothing kept is no match', () => {
		const older = flight();
		const page = $state<{ kept: RunInFlight | null }>({ kept: null });
		page.kept = flight();
		expect(isFlight(page.kept, older)).toBe(false);
		expect(isFlight(null, older)).toBe(false);
	});
});
