// "Start from an example" (example.ts, issue #286): where it goes after the
// import, how it fails, and that the example document stays a lazy chunk.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ImportResult, Project, ProjectFile } from '#lib/api/index.js';
import { ApiError } from '#lib/api/client.js';
import { loadExample, opensStraightAway, startFromExample } from './example';

const SRC = fileURLToPath(new URL('../../../', import.meta.url));
const file = { name: 'Example', model: { nodes: [], crops: [], cropAreas: [], transfers: [] } } as ProjectFile;
const loaded = () => Promise.resolve({ default: file });
const result = (r: Partial<ImportResult>) => ({ project: { id: 'p 1', team: null } as Project, ...r }) as ImportResult;
const GET_STARTED = readFileSync(fileURLToPath(new URL('./GetStarted.svelte', import.meta.url)), 'utf8');

describe('startFromExample', () => {
	it('imports the example with a run and opens that run', async () => {
		const importProject = vi.fn(async () => result({ runId: 'r1' }));
		expect(await startFromExample(importProject, loaded)).toEqual({ ok: true, path: '/projects/p%201?tab=runs&run=r1' });
		expect(importProject).toHaveBeenCalledWith(file, { run: true });
	});

	it('a run that failed comes back with why, and the project (still created) to open', async () => {
		expect(await startFromExample(async () => result({ runError: 'model run failed: no rain' }), loaded)).toEqual({
			ok: true,
			path: '/projects/p%201',
			runError: 'model run failed: no rain'
		});
	});

	it('started with automatic runs off at Free’s live limit, it says so, for the plan that bills it', async () => {
		const ok = await startFromExample(async () => result({ runId: 'r1', autoRunsOff: 'live_catchments' }), loaded);
		expect(ok).toEqual({ ok: true, path: '/projects/p%201?tab=runs&run=r1', autoRunsOff: { teamId: null } });
		const inTeam = await startFromExample(
			async () => ({ project: { id: 'p2', team: { id: 't1', name: 'T' } } as Project, runError: 'no rain', autoRunsOff: 'live_catchments' }) as ImportResult,
			loaded
		);
		expect(inTeam).toEqual({ ok: true, path: '/projects/p2', runError: 'no rain', autoRunsOff: { teamId: 't1' } });
	});

	it('any other autoRunsOff, or none, leaves automatic runs out of it', async () => {
		const other = await startFromExample(async () => result({ runId: 'r1', autoRunsOff: 'something_else' as 'live_catchments' }), loaded);
		expect(other).toEqual({ ok: true, path: '/projects/p%201?tab=runs&run=r1' });
	});

	it('a chunk that didn’t download is a chunk failure, and nothing is imported', async () => {
		const importProject = vi.fn();
		expect(await startFromExample(importProject, () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')))).toEqual({
			ok: false,
			kind: 'chunk'
		});
		expect(importProject).not.toHaveBeenCalled();
	});

	it('a refused import says so with the server’s error', async () => {
		const error = new ApiError(413, 'project file larger than 5 MB');
		expect(await startFromExample(() => Promise.reject(error), loaded)).toEqual({ ok: false, kind: 'import', error });
	});
});

describe('opensStraightAway', () => {
	it('opens a run that went well with nothing to say, and holds the card for a failed run or automatic runs off', () => {
		expect(opensStraightAway({ ok: true, path: '/projects/p' })).toBe(true);
		expect(opensStraightAway({ ok: true, path: '/projects/p', runError: 'x' })).toBe(false);
		expect(opensStraightAway({ ok: true, path: '/projects/p', autoRunsOff: { teamId: null } })).toBe(false);
	});
});

// GetStarted reads the app's API, which needs SvelteKit's env, so it doesn't render in a unit test: this pins the
// wiring in its source (as import/importDone.test.ts does for the import dialog), and e2e projects.spec.ts the flow.
describe('GetStarted after the example import', () => {
	it('navigates only when opensStraightAway says so, else holds the card', () => {
		expect(GET_STARTED).toContain('else if (!opensStraightAway(r)) held = r;');
		expect(GET_STARTED).toContain('else if (!gone) await goto(`${basePath()}${r.path}`);');
	});

	it('shows the shared auto-runs-off line, for the plan that bills the example, only when the answer said so', () => {
		expect(GET_STARTED).toContain('{#if held?.autoRunsOff}<div class="held-note"><AutoRunsOffNotice teamId={held.autoRunsOff.teamId} /></div>{/if}');
		expect(GET_STARTED).toContain("import AutoRunsOffNotice from '#lib/components/billing/AutoRunsOffNotice.svelte';");
		expect(GET_STARTED).not.toMatch(/Free runs one catchment live/);
	});
});

describe('the example document', () => {
	it('loads as a project document of the invented example', async () => {
		const doc = (await loadExample()).default;
		expect(doc.name).toMatch(/^Example · /);
		expect(doc.description).toMatch(/^Invented demo catchment\./);
		expect(doc.model.nodes.length).toBeGreaterThan(0);
		expect(doc.series?.map((s) => s.kind)).toContain('rain_catchment_mm');
	});

	it('is only ever imported dynamically, so it stays out of the page chunks', () => {
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) walk(path);
				else if (/\.(ts|js|svelte)$/.test(name) && !name.endsWith('.test.ts')) files.push(path);
			}
		};
		walk(SRC);
		const refs = files.filter((f) => readFileSync(f, 'utf8').includes('exampleCatchment.generated.json')).map((f) => relative(SRC, f));
		expect(refs).toEqual(['lib/components/projects/example.ts']);
		const code = readFileSync(join(SRC, refs[0]!), 'utf8');
		expect(code).toContain("import('./exampleCatchment.generated.json')");
		expect(code).not.toMatch(/^\s*import\s[^(]*exampleCatchment\.generated\.json/m);
	});
});
