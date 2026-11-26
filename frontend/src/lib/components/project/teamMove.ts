// The Project page's Team panel (docs/ui.md § Teams): who may move a project,
// and where to. Mirrors PATCH /projects/:id { teamId } (projects/routes.ts):
// moving is an owner's; a team it goes to needs member or admin there; taking
// it out of its team, or into another, needs admin on the team it is in
// (issue #900, 392_team_project_move_admin). An owner through the team alone
// may make it personal: the route keeps the mover as a direct owner.
import { hasTeamRole, type Project, type Team } from '#lib/api/types.js';

export type TeamMove =
	| { kind: 'none' }
	/** An owner who isn't an admin of the project's team: the panel says why instead of a form. */
	| { kind: 'admin_only' }
	/** The choices: Personal (always) and the teams the owner may add projects to. */
	| { kind: 'choose'; teams: Pick<Team, 'id' | 'name'>[] };

export function teamMoveChoices(isOwner: boolean, team: Project['team'], teams: Pick<Team, 'id' | 'name' | 'role'>[]): TeamMove {
	if (!isOwner) return { kind: 'none' };
	if (team && team.role !== 'admin') return { kind: 'admin_only' };
	return { kind: 'choose', teams: teams.filter((t) => hasTeamRole(t.role, 'member')).map(({ id, name }) => ({ id, name })) };
}
