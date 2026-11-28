import { describe, expect, it } from 'vitest';
import type { RunMeta } from '#lib/api/types.js';
import { fmtProjectStamp } from '#lib/components/project/project.js';
import { compareSearch, compareTabHref, defaultPair, defaultRunFor, defaultWhatIf, formatRef, parseRef, projectZoneOf, publishedBaseline, runOptionLabel, runPickName, runsTabSearch, SCENARIO_NAME_MAX, staleComparisonNote, waitingSides } from './picker';

const run = (id: string, label = ''): RunMeta => ({
	id,
	label,
	engineVersion: '0.2.0',
	startDate: '2000-01-01',
	endDate: '2020-12-31',
	createdAt: '2026-09-23T12:00:00Z',
	createdBy: 'A',
	legacy: false
});

describe('run refs', () => {
	it('parses and formats <projectId>:<runId>', () => {
		expect(parseRef('p1:r1')).toEqual({ projectId: 'p1', runId: 'r1' });
		expect(formatRef({ projectId: 'p1', runId: 'r1' })).toBe('p1:r1');
		for (const bad of [null, undefined, '', 'p1', 'p1:', ':r1', 'p1:r1:x']) expect(parseRef(bad)).toBeNull();
	});

	it('builds the page query, ?project= only when no side is chosen', () => {
		const a = { projectId: 'p', runId: 'r1' };
		const b = { projectId: 'q', runId: 'r2' };
		expect(compareSearch(a, b)).toBe('?a=p%3Ar1&b=q%3Ar2');
		expect(compareSearch(a, null, 'p')).toBe('?a=p%3Ar1');
		expect(compareSearch(null, null, 'p')).toBe('?project=p');
		expect(compareSearch(null, null)).toBe('');
	});

	it('adds the second what-if as c, after a and b, and round-trips it', () => {
		const a = { projectId: 'p', runId: 'r1' };
		const b = { projectId: 'p', runId: 'r2' };
		const c = { projectId: 'q', runId: 'r3' };
		const s = compareSearch(a, b, 'p', c);
		expect(s).toBe('?a=p%3Ar1&b=p%3Ar2&c=q%3Ar3');
		const q = new URLSearchParams(s);
		expect([q.get('a'), q.get('b'), q.get('c')].map(parseRef)).toEqual([a, b, c]);
		// An old two-run link is unchanged.
		expect(compareSearch(a, b, 'p', null)).toBe('?a=p%3Ar1&b=p%3Ar2');
	});
});

describe('picker defaults', () => {
	it('opens with A = previous run and B = latest run of the project', () => {
		expect(defaultPair('p', [run('new'), run('old'), run('older')])).toEqual({
			a: { projectId: 'p', runId: 'old' },
			b: { projectId: 'p', runId: 'new' }
		});
	});

	it('opens with A = the published baseline when it isn’t the latest run', () => {
		const pub = { ...run('older'), published: true };
		expect(defaultPair('p', [run('new'), run('old'), pub])).toEqual({
			a: { projectId: 'p', runId: 'older' },
			b: { projectId: 'p', runId: 'new' }
		});
	});

	it('falls back to the previous run when the latest run is the published one', () => {
		expect(defaultPair('p', [{ ...run('new'), published: true }, run('old')])).toEqual({
			a: { projectId: 'p', runId: 'old' },
			b: { projectId: 'p', runId: 'new' }
		});
	});

	it('has no default pair with fewer than two runs', () => {
		expect(defaultPair('p', [run('only')])).toBeNull();
		expect(defaultPair('p', [])).toBeNull();
	});

	it('switching a side to a project avoids the run chosen on the other side', () => {
		const runs = [run('r3'), run('r2'), run('r1')];
		expect(defaultRunFor(runs, { projectId: 'p', runId: 'r3' }, 'p')).toBe('r2');
		expect(defaultRunFor(runs, { projectId: 'other', runId: 'r3' }, 'p')).toBe('r3');
		expect(defaultRunFor(runs, null, 'p')).toBe('r3');
		expect(defaultRunFor([run('r1')], { projectId: 'p', runId: 'r1' }, 'p')).toBe('r1');
		expect(defaultRunFor([], null, 'p')).toBeNull();
	});

	it('adds as what-if 2 the newest run that is neither the baseline nor what-if 1', () => {
		const runs = [run('r4'), run('r3'), run('r2'), run('r1')];
		const p = (runId: string) => ({ projectId: 'p', runId });
		expect(defaultWhatIf(runs, [p('r1'), p('r4')], 'p')).toBe('r3');
		expect(defaultWhatIf(runs, [p('r3'), p('r4')], 'p')).toBe('r2');
		// A run of another project isn't taken here.
		expect(defaultWhatIf(runs, [{ projectId: 'q', runId: 'r4' }, null], 'p')).toBe('r4');
		expect(defaultWhatIf([run('r2'), run('r1')], [p('r1'), p('r2')], 'p')).toBeNull();
	});

	it('labels runs, falling back to "Untitled run"', () => {
		const fmt = (iso: string) => iso.slice(0, 10);
		expect(runOptionLabel(run('r', 'Baseline'), fmt)).toBe('Baseline · 2026-09-23 · 2000–2020');
		expect(runOptionLabel(run('r'), fmt)).toBe('Untitled run · 2026-09-23 · 2000–2020');
		expect(runOptionLabel({ ...run('r', 'Base'), published: true }, fmt, true)).toBe('Base · 2026-09-23 · 2000–2020 · latest · published');
	});

	it('adds the Runs list tags that apply, in its order', () => {
		const fmt = (iso: string) => iso.slice(0, 10);
		const tagged: RunMeta = { ...run('r', 'Dam raise'), evidence: 'current', pinned: true, legacy: true };
		expect(runOptionLabel(tagged, fmt, true)).toBe('Dam raise · 2026-09-23 · 2000–2020 · latest · evidence · pinned · workbook comparison');
		expect(runOptionLabel({ ...run('r', 'Old'), evidence: 'past' }, fmt)).toBe('Old · 2026-09-23 · 2000–2020 · former evidence');
	});
});

describe('publishedBaseline (the "Compare with published" offer)', () => {
	const runs = [run('r3'), { ...run('r2'), published: true }, run('r1')];
	const ref = (runId: string, projectId = 'p') => ({ projectId, runId });

	it('offers B’s project’s published run as A', () => {
		expect(publishedBaseline(runs, ref('r1'), ref('r3'))).toEqual(ref('r2'));
		expect(publishedBaseline(runs, null, ref('r3'))).toEqual(ref('r2'));
		// A from another project: the offer is still B's project's baseline.
		expect(publishedBaseline(runs, ref('x', 'q'), ref('r3'))).toEqual(ref('r2'));
	});

	it('offers nothing when it would change nothing', () => {
		expect(publishedBaseline(runs, ref('r2'), ref('r3'))).toBeNull(); // A is already it
		expect(publishedBaseline(runs, ref('r1'), ref('r2'))).toBeNull(); // B is the published run
		expect(publishedBaseline([run('r3'), run('r1')], ref('r1'), ref('r3'))).toBeNull(); // nothing published
		expect(publishedBaseline(undefined, ref('r1'), ref('r3'))).toBeNull(); // runs not loaded yet
		expect(publishedBaseline(runs, ref('r1'), null)).toBeNull(); // no B
	});
});

describe('compareTabHref', () => {
	it('opens the workspace tab with the pair, and never names the project', () => {
		const a = { projectId: 'p', runId: 'r1' };
		const b = { projectId: 'q', runId: 'r2' };
		expect(compareTabHref(a, b)).toBe('?tab=compare&a=p%3Ar1&b=q%3Ar2');
		expect(compareTabHref(null, b)).toBe('?tab=compare&b=q%3Ar2');
		expect(compareTabHref(null, null)).toBe('?tab=compare');
		expect(compareTabHref(a, b, { projectId: 'p', runId: 'r3' })).toBe('?tab=compare&a=p%3Ar1&b=q%3Ar2&c=p%3Ar3');
	});
});

describe('runPickName / a scenario’s run in a picker', () => {
	const fmt = (iso: string) => iso.slice(0, 10);
	const sc = (label: string, scenarioName: string | null, extra: Partial<RunMeta> = {}) => ({ ...run('r', label), scenarioId: 's', scenarioName, fromScenario: true, ...extra });

	it('says a run of the scenario’s default label is the scenario’s', () => {
		expect(runOptionLabel({ ...sc('Hexberg Dam', 'Hexberg Dam'), startDate: '1981-01-01', endDate: '2026-11-01' }, fmt)).toBe('Hexberg Dam (scenario) · 2026-09-23 · 1981–2026');
		expect(runPickName(sc('', 'Hexberg Dam'))).toBe('Hexberg Dam (scenario)');
		expect(runPickName(sc('Hexberg Dam (as licensed)', 'Hexberg Dam'))).toBe('Hexberg Dam (scenario, as licensed)');
	});

	it('names the scenario after a label of the user’s own, cut short when long', () => {
		expect(runPickName(sc('Wet years', 'Hexberg Dam'))).toBe('Wet years (scenario: Hexberg Dam)');
		const long = 'Raise the Hexberg Dam wall by four metres and add a second off-take';
		const named = runPickName(sc('Try 2', long));
		expect(named.startsWith('Try 2 (scenario: Raise the Hexberg Dam wall')).toBe(true);
		expect(named.endsWith('…)')).toBe(true);
		expect(named.length).toBeLessThanOrEqual('Try 2 (scenario: '.length + SCENARIO_NAME_MAX + 1);
	});

	it('still says scenario once the scenario is deleted (fromScenario, scenarioId null)', () => {
		expect(runPickName(sc('Twice the demand', 'Twice the demand', { scenarioId: null }))).toBe('Twice the demand (scenario)');
		expect(runPickName(sc('Old', null, { scenarioId: null }))).toBe('Old (scenario)');
	});

	it('leaves a run of the model as its label (positive control)', () => {
		expect(runPickName({ ...run('r', 'Baseline'), fromScenario: false, scenarioId: null, scenarioName: null })).toBe('Baseline');
		expect(runPickName(run('r'))).toBe('Untitled run');
	});
});

describe('projectZoneOf (issue #899: each compared run on its own project\'s clock)', () => {
	const projects = [
		{ id: 'p1', timeZone: 'Africa/Johannesburg' },
		{ id: 'p2', timeZone: 'America/St_Johns' },
		{ id: 'p3' }
	];

	it("reads a side's zone from the compare response, else the project list, else the fallback", () => {
		expect(projectZoneOf({ project: { timeZone: 'America/St_Johns' } }, null, 'Africa/Johannesburg')).toBe('America/St_Johns');
		expect(projectZoneOf({ project: {} }, null, 'Africa/Johannesburg')).toBe('Africa/Johannesburg');
		expect(projectZoneOf(projects, 'p2', 'Africa/Johannesburg')).toBe('America/St_Johns');
		expect(projectZoneOf(projects, 'p3', 'UTC')).toBe('UTC');
		expect(projectZoneOf(projects, 'gone', 'UTC')).toBe('UTC');
		expect(projectZoneOf(projects, null, 'UTC')).toBe('UTC');
		expect(projectZoneOf(null, 'p1', 'UTC')).toBe('UTC');
	});

	it('dates two runs made at the same moment in their own projects near midnight, whatever the viewer\'s zone (skewed TZ)', () => {
		const prev = process.env.TZ;
		try {
			process.env.TZ = 'Pacific/Kiritimati';
			const at = '2026-10-26T22:30:00.000Z';
			const a = { project: { timeZone: 'Africa/Johannesburg' } };
			const b = { project: { timeZone: 'America/St_Johns' } };
			expect(fmtProjectStamp(at, projectZoneOf(a, null, 'UTC'))).toBe('27 Oct 2026 00:30');
			expect(fmtProjectStamp(at, projectZoneOf(b, null, 'UTC'))).toBe('26 Oct 2026 20:00');
		} finally {
			process.env.TZ = prev;
		}
	});
});

describe('waitingSides / staleComparisonNote (issue #924: a card picked onto a project with no runs)', () => {
	const sides = ['a', 'b', 'c'] as const;
	it('counts a pick whose runs came back empty or failed, not one still loading or with runs', () => {
		const runs = { empty: [], full: [{ id: 'r1' }] };
		const errors = { broken: 'Project not found or not shared with you' };
		expect(waitingSides({ a: null, b: null, c: null }, runs, errors, sides)).toEqual([]);
		expect(waitingSides({ a: null, b: 'empty', c: null }, runs, errors, sides)).toEqual(['b']);
		expect(waitingSides({ a: 'broken', b: 'loading', c: 'full' }, runs, errors, sides)).toEqual(['a']);
		expect(waitingSides({ a: 'empty', b: null, c: 'broken' }, runs, errors, sides)).toEqual(['a', 'c']);
	});
	it('names each waiting card, its project and why, and says the comparison is of the runs before', () => {
		expect(staleComparisonNote([])).toBeNull();
		expect(staleComparisonNote([{ card: 'What-if 1', project: 'Empty', failed: false }])).toBe(
			"What-if 1's project, Empty, has no runs, so the comparison below is still of the runs chosen before. Pick a project with runs, or go Back."
		);
		expect(
			staleComparisonNote([
				{ card: 'Baseline', project: 'Gone', failed: true },
				{ card: 'What-if 2', project: 'Empty', failed: false }
			])
		).toBe("Baseline's project, Gone, couldn't load its runs and What-if 2's project, Empty, has no runs, so the comparison below is still of the runs chosen before. Pick a project with runs, or go Back.");
	});
});

describe('runsTabSearch (issue #924: the standalone page’s Back to runs keeps the run)', () => {
	it('opens the Runs tab on what-if 1 when it is the project’s, else the baseline, else no run', () => {
		expect(runsTabSearch('p1', { projectId: 'p1', runId: 'ra' }, { projectId: 'p1', runId: 'rb' })).toBe('?tab=runs&run=rb');
		expect(runsTabSearch('p1', { projectId: 'p1', runId: 'ra' }, { projectId: 'p2', runId: 'rb' })).toBe('?tab=runs&run=ra');
		expect(runsTabSearch('p1', { projectId: 'p1', runId: 'ra' }, null)).toBe('?tab=runs&run=ra');
		expect(runsTabSearch('p1', null, null)).toBe('?tab=runs');
		expect(runsTabSearch('p1', null, { projectId: 'p2', runId: 'rb' })).toBe('?tab=runs');
	});
});
