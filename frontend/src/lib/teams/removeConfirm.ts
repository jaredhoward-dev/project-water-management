// The confirmation before someone leaves a team or is removed from it (teams/[id]/+page.svelte).
// Leaving takes the person's direct roles on the team's projects too, the ones they created
// included; a project they alone owned passes to a team owner (backend teams/leaveProjects.ts,
// operator decision 2026-11-24). A farmer's link to their own farm stays.
export interface RemoveConfirm {
	title: string;
	message: string;
	confirmLabel: string;
	danger: true;
}

export function removeMemberConfirm(team: string | undefined, member: { displayName: string; email: string }, self: boolean): RemoveConfirm {
	return self
		? {
				title: `Leave ${team ?? 'this team'}?`,
				message: 'You lose your access to its projects, including the ones you created. The team’s owners keep them.',
				confirmLabel: 'Leave team',
				danger: true
			}
		: {
				title: 'Remove this member?',
				message: `Remove ${member.displayName} (${member.email}) from the team? They lose their access to its projects, including the ones they created. The team’s owners keep them.`,
				confirmLabel: 'Remove member',
				danger: true
			};
}
