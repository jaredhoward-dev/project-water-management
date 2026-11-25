// ImportProjectDialog's done state with Free's live limit (338; docs/ui.md § The project list): an import of a file
// with automatic runs on, at the limit, comes back with `autoRunsOff: "live_catchments"`, and the done state shows
// AutoRunsOffNotice (its words and Compare plans link: billing/planLink.test.ts) for the plan that bills the new
// project. The dialog reads the app's API, which needs SvelteKit's env, so it doesn't render in a unit test: this pins
// the wiring in its source, and e2e project-import.spec.ts the browser flow.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(fileURLToPath(new URL('./ImportProjectDialog.svelte', import.meta.url)), 'utf8');

describe('ImportProjectDialog’s done state (autoRunsOff)', () => {
	it('shows the auto-runs-off line, for the new project’s team, only when the answer says so', () => {
		const done = SOURCE.slice(SOURCE.indexOf("{:else if step === 'done' && result}"), SOURCE.indexOf("{:else if step === 'failed' && failure}"));
		expect(done).toContain('{#if startedAutoRunsOff(result)}<AutoRunsOffNotice team={result.project.team} />{/if}');
	});

	it('imports the shared notice and test, not its own copy of the words', () => {
		expect(SOURCE).toContain("import AutoRunsOffNotice from '#lib/components/billing/AutoRunsOffNotice.svelte';");
		expect(SOURCE).toContain("import { startedAutoRunsOff } from '#lib/components/billing/liveLimit.js';");
		expect(SOURCE).not.toMatch(/Free runs one catchment live/);
	});
});
