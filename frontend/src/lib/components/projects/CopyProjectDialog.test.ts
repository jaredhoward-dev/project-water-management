// The Copy project dialog (CopyProjectDialog.svelte): the form, and the done state Free's live limit brings
// (`autoRunsOff`, 338): why the copy starts with automatic runs off, Compare plans for the plan that bills it,
// and Open project. Rendered with Svelte's server renderer; the browser flow is e2e projects.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { CopyResult, Project, ProjectSummary } from '#lib/api/types.js';
import { AUTO_RUNS_OFF_TEXT } from '#lib/components/billing/liveLimit.js';
import CopyProjectDialog from './CopyProjectDialog.svelte';

vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));

const source = { id: 'p1', name: 'Upper', team: { id: 't1', name: 'WUA' } } as ProjectSummary;
const copied = (team: Project['team'], autoRunsOff?: 'live_catchments'): CopyResult => ({
	project: { id: 'p2', name: 'Upper (copy)', team } as Project,
	...(autoRunsOff ? { autoRunsOff } : {})
});
const html = (props: Record<string, unknown>) =>
	render(CopyProjectDialog, { props: { open: true, source, canAddTo: () => true, docopy: async () => copied(null), ...props } as never }).body;

describe('CopyProjectDialog', () => {
	it('asks for the copy’s name, and says where it goes', () => {
		const h = html({});
		expect(h).toContain('id="cp-name"');
		expect(h).toContain('The copy stays in WUA.');
		expect(h).not.toContain('data-testid="auto-runs-off"');
		expect(html({ canAddTo: () => false })).toContain("You're a viewer in WUA, so the copy is personal.");
	});

	it('a copy made with automatic runs off: says why, Compare plans opens the team’s plan, and Open project opens the copy', () => {
		const h = html({ done: copied({ id: 't1', name: 'WUA', role: 'admin' }, 'live_catchments') });
		expect(h).toContain('Project copied');
		expect(h).toContain('data-testid="copy-done"');
		expect(h).toContain(AUTO_RUNS_OFF_TEXT);
		expect(h).toContain('href="/teams/t1/plan"');
		expect(h).toContain('href="/projects/p2"');
		expect(h).not.toContain('id="cp-name"');
	});

	it('a team member who isn’t its admin gets the price list and whose plan it is, not a plan page they can’t open', () => {
		const h = html({ done: copied({ id: 't1', name: 'WUA', role: 'member' }, 'live_catchments') });
		expect(h).toContain('href="/welcome/pricing"');
		expect(h).toContain('WUA');
		expect(h).not.toContain('/teams/');
	});

	it('a personal copy’s Compare plans opens your own plan', () => {
		const h = html({ done: copied(null, 'live_catchments') });
		expect(h).toContain('href="/account/plan"');
		expect(h).not.toContain('/teams/');
	});
});
