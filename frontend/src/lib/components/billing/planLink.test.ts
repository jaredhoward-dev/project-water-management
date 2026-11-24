// Where Compare plans goes (planLink.ts): the plan of the account that bills the catchment, a team's for a team
// catchment, else your own; and the notices that link there, rendered with Svelte's server renderer (with and
// without the workspace's context). The browser flows: e2e data-feeds.spec.ts, projects.spec.ts, project-import.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { BILLING_TEAM_CONTEXT, planHref } from './planLink';
import { AUTO_RUNS_OFF_TEXT, LIVE_LIMIT_TEXT, startedAutoRunsOff } from './liveLimit';
import AutoRunsOffNotice from './AutoRunsOffNotice.svelte';
import LiveLimitNotice from './LiveLimitNotice.svelte';

vi.mock('$app/paths', () => ({ resolve: (p: string) => `/app/${p}`, asset: (f: string) => `/app/${f}` }));

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe('planHref', () => {
	it('is the team’s plan for a team catchment, else your own, after the base path', () => {
		expect(planHref('t1')).toBe('/teams/t1/plan');
		expect(planHref('t1', '/app')).toBe('/app/teams/t1/plan');
		expect(planHref(null)).toBe('/account/plan');
		expect(planHref(undefined, '/app')).toBe('/app/account/plan');
		expect(planHref('')).toBe('/account/plan');
	});

	it('encodes the team id, so a hostile one stays a path segment on the app’s origin', () => {
		expect(planHref('a/b?c#d')).toBe('/teams/a%2Fb%3Fc%23d/plan');
		for (const id of ['javascript:alert(1)', '//evil.example', '/\\evil.example', '..']) {
			const href = planHref(id);
			expect(href.startsWith('/teams/')).toBe(true);
			expect(new URL(href, 'https://app.example/projects/p1').origin).toBe('https://app.example');
		}
	});
});

describe('LiveLimitNotice (338)', () => {
	it('outside a workspace, Compare plans opens your own plan', () => {
		const html = render(LiveLimitNotice, { props: {} }).body;
		expect(html).toContain(LIVE_LIMIT_TEXT);
		expect(hrefs(html)).toEqual(['/app/account/plan']);
	});

	it('in a team catchment’s workspace, the team’s plan (the context the workspace provides)', () => {
		const html = render(LiveLimitNotice, { props: {}, context: new Map([[BILLING_TEAM_CONTEXT, () => 't 1']]) }).body;
		expect(hrefs(html)).toEqual(['/app/teams/t%201/plan']);
		const personal = render(LiveLimitNotice, { props: {}, context: new Map([[BILLING_TEAM_CONTEXT, () => undefined]]) }).body;
		expect(hrefs(personal)).toEqual(['/app/account/plan']);
	});

	it('a teamId prop wins over the context', () => {
		const html = render(LiveLimitNotice, { props: { teamId: 't2' }, context: new Map([[BILLING_TEAM_CONTEXT, () => 't1']]) }).body;
		expect(hrefs(html)).toEqual(['/app/teams/t2/plan']);
	});
});

describe('AutoRunsOffNotice (the copy and import dialogs’ done state)', () => {
	it('says why the new project starts with automatic runs off, with Compare plans for the plan that bills it', () => {
		const team = render(AutoRunsOffNotice, { props: { teamId: 't1' } }).body;
		expect(team).toContain('data-testid="auto-runs-off"');
		expect(team).toContain(AUTO_RUNS_OFF_TEXT);
		expect(hrefs(team)).toEqual(['/app/teams/t1/plan']);
		expect(hrefs(render(AutoRunsOffNotice, { props: { teamId: null } }).body)).toEqual(['/app/account/plan']);
	});

	it('is an information note in #641’s words, never an error', () => {
		const html = render(AutoRunsOffNotice, { props: { teamId: null } }).body;
		expect(html).toContain('alert-info');
		expect(html).not.toContain('alert-error');
		expect(AUTO_RUNS_OFF_TEXT).not.toMatch(/quota|abuse|402|error/i);
		expect(AUTO_RUNS_OFF_TEXT).toMatch(/automatic runs off/);
	});
});

describe('startedAutoRunsOff', () => {
	it('is the API’s autoRunsOff "live_catchments", and nothing else', () => {
		expect(startedAutoRunsOff({ autoRunsOff: 'live_catchments' })).toBe(true);
		expect(startedAutoRunsOff({})).toBe(false);
		expect(startedAutoRunsOff({ autoRunsOff: null })).toBe(false);
		expect(startedAutoRunsOff({ autoRunsOff: 'something_else' })).toBe(false);
		expect(startedAutoRunsOff(null)).toBe(false);
	});
});
