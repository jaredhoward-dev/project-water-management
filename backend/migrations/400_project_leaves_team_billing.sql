-- 400_project_leaves_team_billing — a project leaving its team bills to someone
-- still on it (issue #641 § Who the plan belongs to; docs/billing.md § Who the
-- plan belongs to).
--
-- 323's project_billing_account_set billed a project with no team to its
-- creator's own account, whenever it left a team. Since 2026-11-24 leaving a
-- team takes the leaver's direct roles on its projects (teams/leaveProjects.ts,
-- ownership handed to a team admin), and since #900 (392) only a team admin
-- takes a project out. So a member who made a team project and then left
-- could have it billed to them when an admin later took it out: their Free
-- plan counted a catchment they can't open, its live operations took their one
-- live catchment, and the move was checked (340's project_move_live_guard), or
-- their own catchments paused (341), against a plan that wasn't the mover's.
--
-- Redefined from 323 (its only definition). When the project leaves a team
-- (team_id to null on UPDATE), it bills to, in order:
--   1. its creator, while they are a direct owner of it (the rule as before);
--   2. the person taking it out, when they are a direct owner (the PATCH route
--      always makes the mover one, projects/routes.ts);
--   3. its longest-standing direct owner (the schema owner's SQL, no one
--      signed in);
--   4. its creator (null for a deleted account: no account, as before).
-- A new project (INSERT) and a move into a team are unchanged. Only the moment
-- it leaves picks the account: a later change of owners moves nothing, as
-- before. SECURITY DEFINER as 323's, so it reads project_member whatever RLS
-- shows the caller.

CREATE OR REPLACE FUNCTION project_billing_account_set() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
		v_payer uuid;
	BEGIN
		IF TG_OP = 'UPDATE' AND NEW.team_id IS NOT DISTINCT FROM OLD.team_id THEN
			RETURN NEW;
		END IF;
		IF NEW.team_id IS NOT NULL THEN
			v_account := billing_account_ensure('team', NEW.team_id);
		ELSE
			v_payer := NEW.created_by;
			IF TG_OP = 'UPDATE' AND NOT EXISTS (
				SELECT 1 FROM project_member m WHERE m.project_id = NEW.id AND m.user_id = NEW.created_by AND m.role = 'owner'
			) THEN
				SELECT m.user_id INTO v_payer FROM project_member m
					WHERE m.project_id = NEW.id AND m.role = 'owner'
					ORDER BY (m.user_id IS NOT DISTINCT FROM app_current_user_id()) DESC, m.added_at, m.user_id
					LIMIT 1;
				v_payer := coalesce(v_payer, NEW.created_by);
			END IF;
			v_account := billing_account_ensure('user', v_payer);
		END IF;
		IF TG_OP = 'INSERT' OR v_account IS DISTINCT FROM OLD.billing_account_id THEN
			UPDATE billing_account SET projects_created = projects_created + 1 WHERE id = v_account;
		END IF;
		NEW.billing_account_id := v_account;
		RETURN NEW;
	END
	$$;
REVOKE ALL ON FUNCTION project_billing_account_set() FROM PUBLIC, water_app;
