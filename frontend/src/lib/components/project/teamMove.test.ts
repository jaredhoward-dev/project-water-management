import { describe, expect, it } from 'vitest';
import { teamMoveChoices } from './teamMove';

const teams = [
	{ id: 't1', name: 'Consultants', role: 'admin' as const },
	{ id: 't2', name: 'Board', role: 'member' as const },
	{ id: 't3', name: 'Readers', role: 'viewer' as const }
];

describe('teamMoveChoices', () => {
	it('lets a team admin who owns the project only through the team move it to personal or another team', () => {
		expect(teamMoveChoices(true, { id: 't1', name: 'Consultants', role: 'admin' }, teams)).toEqual({
			kind: 'choose',
			teams: [
				{ id: 't1', name: 'Consultants' },
				{ id: 't2', name: 'Board' }
			]
		});
	});

	it('keeps a plain member owner, or an owner outside the team, from moving it out (issue #900)', () => {
		expect(teamMoveChoices(true, { id: 't2', name: 'Board', role: 'member' }, teams)).toEqual({ kind: 'admin_only' });
		expect(teamMoveChoices(true, { id: 'tx', name: null, role: null }, teams)).toEqual({ kind: 'admin_only' });
	});

	it('lets a personal project’s owner move it into a team they belong to as member or admin, not one they only view', () => {
		const m = teamMoveChoices(true, null, teams);
		expect(m.kind === 'choose' && m.teams.map((t) => t.id)).toEqual(['t1', 't2']);
	});

	it('offers nothing to someone who isn’t an owner', () => {
		expect(teamMoveChoices(false, null, teams)).toEqual({ kind: 'none' });
	});
});
