// A failed full-allocation run answers a fixed line, never the thrown error's
// text (evidence/authorisedImpact.ts engineRun; CLAUDE.md rule 6).
import { runModelChecked, type ModelInput } from '@water-management/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testCatchment } from '../../../packages/engine/src/outlook/testCatchment.js';
import { ApiError } from '../http/errors.js';
import { engineRun } from './authorisedImpact.js';

afterEach(() => vi.restoreAllMocks());

/** What the engine itself throws for `input`. */
function engineMessage(input: ModelInput): string {
	try {
		runModelChecked(input);
	} catch (err) {
		return (err as Error).message;
	}
	throw new Error('expected the engine to throw');
}

describe('engineRun', () => {
	it('runs a sound input (positive control)', () => {
		expect(engineRun(testCatchment() as ModelInput, 'baseline').summary).toBeDefined();
	});

	it('refuses a failing run with a fixed 409, and logs where without the message', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		// A broken input: the engine throws a runtime error naming its internals.
		const broken = { ...testCatchment(), model: { nodes: null } } as unknown as ModelInput;
		const raw = engineMessage(broken);
		expect(raw.length).toBeGreaterThan(0);

		let thrown: unknown;
		try {
			engineRun(broken, 'application');
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(ApiError);
		const e = thrown as ApiError;
		expect(e.status).toBe(409);
		expect(e.message).toBe('the full-allocation application couldn’t be run: check the model and the application run, then try again');
		expect(e.message).not.toContain(raw);

		const lines = warn.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>);
		const line = lines.find((l) => l.event === 'authorised_impact_run_failed');
		expect(line).toMatchObject({ which: 'application', error: expect.any(String) });
		expect(Array.isArray(line!.at)).toBe(true);
		expect(JSON.stringify(line)).not.toContain(raw);
	});
});
