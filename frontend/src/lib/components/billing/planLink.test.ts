// Where Compare plans goes (planLink.ts): the plan of the account that bills the catchment, a team's for a team
// admin, the price list with "ask a team admin" for anyone else in a team catchment, else your own; and the notices that link there, rendered with Svelte's server renderer (with and
// without the workspace's context). The browser flows: e2e data-feeds.spec.ts, projects.spec.ts, project-import.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { BILLING_TEAM_CONTEXT, PRICING_HREF, planHref, planLink } from './planLink';
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

describe('planLink: who can open the plan the catchment is billed to', () => {
	const ASK = /^This catchment is on .+: ask a team admin to change it\.$/;

	it('a personal catchment (its owner, or anyone shared it): your own plan, no note', () => {
		expect(planLink(null)).toEqual({ href: '/account/plan', note: null });
		expect(planLink(undefined, '/app')).toEqual({ href: '/app/account/plan', note: null });
	});

	it('a team admin (who reads the team’s plan, app_billing_account_readable): the team’s plan, no note', () => {
		expect(planLink({ id: 't1', name: 'WUA', role: 'admin' }, '/app')).toEqual({ href: '/app/teams/t1/plan', note: null });
	});

	it('a team member or viewer (404 on the team’s plan): the price list, naming the team’s plan and to ask a team admin', () => {
		for (const role of ['member', 'viewer'] as const) {
			const link = planLink({ id: 't1', name: 'Sandspruit WUA', role }, '/app');
			expect(link.href).toBe(`/app${PRICING_HREF}`);
			expect(link.note).toBe('This catchment is on Sandspruit WUA’s plan: ask a team admin to change it.');
		}
	});

	it('someone shared the catchment directly, outside the team (no team name, no role): the price list, “its team’s plan”', () => {
		const link = planLink({ id: 't1', name: null, role: null });
		expect(link.href).toBe(PRICING_HREF);
		expect(link.note).toBe('This catchment is on its team’s plan: ask a team admin to change it.');
		expect(link.note).toMatch(ASK);
	});

	it('a team with no role said (the list’s summary, an older API) is not taken for an admin: never a link to a 404', () => {
		const link = planLink({ id: 't1', name: 'WUA' });
		expect(link.href).toBe(PRICING_HREF);
		expect(link.note).toMatch(ASK);
	});

	it('the team’s name is only words, and the admin’s link still encodes a hostile id', () => {
		expect(planLink({ id: 'a/b?c#d', name: null, role: 'admin' }).href).toBe('/teams/a%2Fb%3Fc%23d/plan');
		expect(planLink({ id: 't1', name: '<b>x</b>', role: 'member' }).href).toBe(PRICING_HREF);
	});
});

describe('LiveLimitNotice (338)', () => {
	it('outside a workspace, Compare plans opens your own plan', () => {
		const html = render(LiveLimitNotice, { props: {} }).body;
		expect(html).toContain(LIVE_LIMIT_TEXT);
		expect(hrefs(html)).toEqual(['/app/account/plan']);
	});

	it('in a team catchment’s workspace, a team admin gets the team’s plan (the context the workspace provides)', () => {
		const html = render(LiveLimitNotice, { props: {}, context: new Map([[BILLING_TEAM_CONTEXT, () => ({ id: 't 1', name: 'WUA', role: 'admin' })]]) }).body;
		expect(hrefs(html)).toEqual(['/app/teams/t%201/plan']);
		expect(html).not.toContain('plan-ask-admin');
		const personal = render(LiveLimitNotice, { props: {}, context: new Map([[BILLING_TEAM_CONTEXT, () => undefined]]) }).body;
		expect(hrefs(personal)).toEqual(['/app/account/plan']);
	});

	it('a team member, or someone shared it directly, gets the price list and “ask a team admin”', () => {
		const member = render(LiveLimitNotice, { props: {}, context: new Map([[BILLING_TEAM_CONTEXT, () => ({ id: 't1', name: 'WUA', role: 'member' })]]) }).body;
		expect(hrefs(member)).toEqual(['/app/welcome/pricing']);
		expect(member).toContain('This catchment is on WUA’s plan: ask a team admin to change it.');
		const direct = render(LiveLimitNotice, { props: {}, context: new Map([[BILLING_TEAM_CONTEXT, () => ({ id: 't1', name: null, role: null })]]) }).body;
		expect(hrefs(direct)).toEqual(['/app/welcome/pricing']);
		expect(direct).toContain('This catchment is on its team’s plan: ask a team admin to change it.');
	});

	it('a team prop wins over the context', () => {
		const html = render(LiveLimitNotice, { props: { team: { id: 't2', name: 'B', role: 'admin' } }, context: new Map([[BILLING_TEAM_CONTEXT, () => ({ id: 't1', name: 'A', role: 'admin' })]]) }).body;
		expect(hrefs(html)).toEqual(['/app/teams/t2/plan']);
	});
});

describe('AutoRunsOffNotice (the copy and import dialogs’ done state)', () => {
	it('says why the new project starts with automatic runs off, with Compare plans for the plan that bills it', () => {
		const team = render(AutoRunsOffNotice, { props: { team: { id: 't1', name: 'WUA', role: 'admin' } } }).body;
		expect(team).toContain('data-testid="auto-runs-off"');
		expect(team).toContain(AUTO_RUNS_OFF_TEXT);
		expect(hrefs(team)).toEqual(['/app/teams/t1/plan']);
		expect(hrefs(render(AutoRunsOffNotice, { props: { team: null } }).body)).toEqual(['/app/account/plan']);
		const member = render(AutoRunsOffNotice, { props: { team: { id: 't1', name: 'WUA', role: 'member' } } }).body;
		expect(hrefs(member)).toEqual(['/app/welcome/pricing']);
		expect(member).toContain('This catchment is on WUA’s plan: ask a team admin to change it.');
	});

	it('is an information note in #641’s words, never an error', () => {
		const html = render(AutoRunsOffNotice, { props: { team: null } }).body;
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
