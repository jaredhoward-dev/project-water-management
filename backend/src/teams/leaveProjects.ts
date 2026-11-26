// Someone leaving a team, or removed from it, loses their direct membership of
// the team's projects too (operator decision, 2026-11-24; docs/security.md §
// Authorization → Teams). Before, a member who created a team project stayed
// its direct owner after they left the team, so removing someone from the
// team didn't take away the projects they had made in it.
//
// Run by DELETE /teams/:id/members/:userId in the removal's own transaction,
// under RLS as the caller, before the team_member row goes (the leaver is
// still a member, so the history entries can be written). The route takes
// lockTeamLeave first, so every removal from one team runs one after the
// other and each reads what the one before committed (READ COMMITTED). The
// admin rows assertNotLastAdmin locks can't do that: a plain member leaving
// can't lock them (FOR UPDATE needs the UPDATE policy, a team admin's), so
// without it a member leaving and the admin who would get their project
// leaving at the same moment could each hand to the other.
//
// For each team project the person holds a direct role on (a farmer's row
// stays: it reaches only their own farm, and was given for it):
//  - when they are its only direct owner, ownership is handed to a team
//    admin first: the admin removing them, or, when they leave themselves,
//    the team's longest-standing other admin. The keep-owner trigger
//    (project_member_keep_owner) needs a direct owner row, and team
//    ownership alone doesn't count, so the hand-off keeps it satisfied. The
//    admin gets a direct owner row (or theirs is raised to owner);
//    recorded as member.added / member.role with handedFrom;
//  - their row goes, recorded as member.removed with the team's name.
// The project's owner rows are locked first, as assertNotLastOwner does, so a
// concurrent removal on the project itself waits and then counts afresh.
import type { Db } from '../db/tx.js';
import { recordAudit } from '../history/record.js';

export interface LeftProject {
	projectId: string;
	role: string;
	/** The team admin given direct ownership, when the leaver was its only direct owner. */
	handedTo: string | null;
}

/** Serialise removals from one team (a transaction-scoped advisory lock, the pattern of 149). */
export async function lockTeamLeave(db: Db, teamId: string): Promise<void> {
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('team_leave:' || $1::text, 0))`, [teamId]);
}

export async function leaveTeamProjects(db: Db, teamId: string, team: string, userId: string, actorId: string): Promise<LeftProject[]> {
	const self = userId === actorId;
	const { rows: held } = await db.query<{ project_id: string; role: string; display_name: string }>(
		`SELECT pm.project_id, pm.role, u.display_name
		 FROM project_member pm JOIN project p ON p.id = pm.project_id JOIN app_user u ON u.id = pm.user_id
		 WHERE p.team_id = $1 AND pm.user_id = $2 AND pm.role <> 'farmer'
		 ORDER BY pm.project_id`,
		[teamId, userId]
	);
	const left: LeftProject[] = [];
	for (const h of held) {
		let handedTo: string | null = null;
		if (h.role === 'owner') {
			await db.query(`SELECT 1 FROM project_member WHERE project_id = $1 AND role = 'owner' ORDER BY user_id FOR UPDATE`, [h.project_id]);
			const { rows: others } = await db.query(
				`SELECT 1 FROM project_member WHERE project_id = $1 AND role = 'owner' AND user_id <> $2 LIMIT 1`,
				[h.project_id, userId]
			);
			if (!others[0]) handedTo = await handOwnership(db, teamId, h.project_id, userId, self ? null : actorId, h.display_name);
		}
		await recordAudit(db, h.project_id, 'member.removed', { userId, displayName: h.display_name, role: h.role, self, team, leftTeam: true });
		await db.query('DELETE FROM project_member WHERE project_id = $1 AND user_id = $2', [h.project_id, userId]);
		left.push({ projectId: h.project_id, role: h.role, handedTo });
	}
	return left;
}

/**
 * Give a team admin direct ownership of the project: the removing admin, else the team's longest-standing other admin.
 * An admin holding a farmer row here comes last: that row is about their own farm, and raising it changes its meaning
 * (only when every other admin holds one too). The event names the leaver as `handedFrom` with their id beside it
 * (`handedFromId`), so deleting their account can put "Deleted user" in its place (383_erase_handover_and_invites).
 */
async function handOwnership(db: Db, teamId: string, projectId: string, leaver: string, remover: string | null, leaverName: string): Promise<string> {
	const { rows } = await db.query<{ user_id: string; display_name: string; role: string | null }>(
		`SELECT m.user_id, u.display_name, pm.role
		 FROM team_member m JOIN app_user u ON u.id = m.user_id
		 LEFT JOIN project_member pm ON pm.project_id = $3 AND pm.user_id = m.user_id
		 WHERE m.team_id = $1 AND m.role = 'admin' AND m.user_id <> $2
		 ORDER BY (pm.role IS NOT DISTINCT FROM 'farmer'), (m.user_id = $4) DESC, m.added_at, m.user_id
		 LIMIT 1`,
		[teamId, leaver, projectId, remover]
	);
	const to = rows[0];
	// assertNotLastAdmin ran first: a team always keeps an admin besides the one leaving.
	if (!to) throw new Error('leaveTeamProjects: the team has no other admin to hand the project to');
	if (to.role === null) {
		await db.query(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'owner')`, [projectId, to.user_id]);
		await recordAudit(db, projectId, 'member.added', { userId: to.user_id, displayName: to.display_name, role: 'owner', handedFrom: leaverName, handedFromId: leaver });
	} else {
		await db.query(`UPDATE project_member SET role = 'owner' WHERE project_id = $1 AND user_id = $2`, [projectId, to.user_id]);
		await recordAudit(db, projectId, 'member.role', { userId: to.user_id, displayName: to.display_name, from: to.role, to: 'owner', handedFrom: leaverName, handedFromId: leaver });
	}
	return to.user_id;
}
