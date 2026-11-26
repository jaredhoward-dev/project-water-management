-- 392_team_project_move_admin: taking a project out of a team, or into a
-- different one, needs admin on the team it leaves (issue #900; docs/security.md
-- § Authorization → Teams, docs/data-model.md § Teams).
--
-- Before, PATCH /projects/:id { teamId } asked only for project owner, and
-- project_update (latest: 008_team_viewer) checks only the team the row moves
-- *to*: its WITH CHECK sees the new row, never the old team. So a plain team
-- member who created a team project (its direct owner), or an outside person
-- the team shared it with as a direct owner, could take it out of the team:
-- the team's admins lost every access, and the member could then leave the
-- team and keep it (teams/leaveProjects.ts looks only at projects still in
-- the team), defeating the 2026-11-24 decision that leaving a team takes its
-- projects. Moving a personal project into a team is unchanged (owner, and
-- member or admin of that team: project_update, 008).
--
-- A BEFORE UPDATE OF team_id trigger, since it sees OLD. Only water_app is
-- held to it (as 161's project_public_records_guard and 204's
-- project_require_mfa_guard): the operator, migrations and the FK's
-- ON DELETE SET NULL when a team is deleted (referential actions run as the
-- table's owner) are not. Invoker rights: app_team_role is already a definer
-- function (026) that reads only the caller's own team_member row, so the
-- trigger needs nothing the caller lacks. The route makes the same check
-- first, with the coded error team_move_admin (projects/routes.ts).

CREATE FUNCTION project_team_move_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF current_user = 'water_app' AND OLD.team_id IS NOT NULL AND NEW.team_id IS DISTINCT FROM OLD.team_id
		   AND app_team_role(OLD.team_id) IS DISTINCT FROM 'admin' THEN
			RAISE EXCEPTION 'only an admin of the team project % is in takes it out of the team', OLD.id
				USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER project_team_move_guard BEFORE UPDATE OF team_id ON project
	FOR EACH ROW EXECUTE FUNCTION project_team_move_guard();
REVOKE ALL ON FUNCTION project_team_move_guard() FROM PUBLIC, water_app;
