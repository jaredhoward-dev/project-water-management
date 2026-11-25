import { describe, expect, it } from 'vitest';
import { removeMemberConfirm } from './removeConfirm.js';

const ben = { displayName: 'Ben', email: 'ben@example.com' };

describe('removeMemberConfirm', () => {
	it('says a removed member loses the team’s projects, the ones they created included', () => {
		const c = removeMemberConfirm('Upper WUA', ben, false);
		expect(c).toMatchObject({ title: 'Remove this member?', confirmLabel: 'Remove member', danger: true });
		expect(c.message).toBe(
			'Remove Ben (ben@example.com) from the team? They lose their access to its projects, including the ones they created. The team’s owners keep them.'
		);
		// No longer true: a direct share of a team project goes with the team.
		expect(c.message).not.toMatch(/shared directly/);
	});

	it('says the same to someone leaving', () => {
		const c = removeMemberConfirm('Upper WUA', ben, true);
		expect(c).toMatchObject({ title: 'Leave Upper WUA?', confirmLabel: 'Leave team', danger: true });
		expect(c.message).toBe('You lose your access to its projects, including the ones you created. The team’s owners keep them.');
	});
});
