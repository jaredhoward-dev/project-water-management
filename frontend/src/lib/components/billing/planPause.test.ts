import { describe, expect, it } from 'vitest';
import { pausedNotice } from './planPause';

describe('pausedNotice (341: the workspace notice on a paused catchment)', () => {
	it('says nothing on a catchment that isn’t paused, or from an older API', () => {
		expect(pausedNotice(null)).toBeNull();
		expect(pausedNotice({ planPausedAt: null, team: null })).toBeNull();
		expect(pausedNotice({ team: null })).toBeNull();
	});

	it('says what is paused, since when, that nothing is lost, and links to your own plan', () => {
		const n = pausedNotice({ planPausedAt: '2026-12-03T08:00:00.000Z', team: null })!;
		expect(n.text).toMatch(/^Feeds, alerts and automatic runs are paused here since /);
		expect(n.text).toContain('the plan this catchment is billed to has ended');
		expect(n.text).toContain('Nothing is lost');
		expect(n.teamId).toBeNull();
		expect(n.href).toBe('/account/plan');
		expect(n.linkText).toBe('Plan and usage');
	});

	it('links a team catchment to the team’s plan', () => {
		const n = pausedNotice({ planPausedAt: '2026-12-03T08:00:00.000Z', team: { id: 't1', name: 'WUA' } })!;
		expect(n.teamId).toBe('t1');
		expect(n.href).toBe('/teams/t1/plan');
		expect(n.linkText).toBe('The team’s plan');
	});

	it('puts the base path first', () => {
		expect(pausedNotice({ planPausedAt: '2026-12-03T08:00:00.000Z', team: { id: 't1', name: 'WUA' } }, '/app')!.href).toBe('/app/teams/t1/plan');
		expect(pausedNotice({ planPausedAt: '2026-12-03T08:00:00.000Z', team: null }, '/app')!.href).toBe('/app/account/plan');
	});
});

describe('the paused notice’s words', () => {
	it('never uses the words #641 rules out', () => {
		const n = pausedNotice({ planPausedAt: '2026-12-03T08:00:00.000Z', team: null })!;
		expect(n.text).not.toMatch(/quota|abuse|402|error/i);
	});
});
