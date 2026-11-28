-- 413_rls_sweep_closes — three loose ends the 2026-11-27 RLS sweep found
-- (docs/security.md § Authorization, docs/data-model.md § Access control).
--
-- Expand-only: no table or column changes. Every object below starts from its
-- latest definition, named at it.
--
--  1. delineation_request: id, project_id, created_by and created_at are
--     fixed from the insert. delineation_request_final (latest: 272) froze
--     them only once a request was finished, so while it was queued an
--     editor's transaction (an API bug, an injected query) could name someone
--     else as who queued it, or move it to another project they also edit
--     (clearing job_id in the same statement got past delineation_request_job).
--     created_by still changes when its foreign key clears it (the account is
--     gone). The function becomes SECURITY DEFINER, as 185 made the
--     proposals' final triggers, so app_user's RLS can't hide a live account
--     from the "is it gone?" check; it is revoked from PUBLIC and water_app.
--
--  2. app_share_allowed (049) answered for any project and any two accounts,
--     to any caller water_app runs as (a signed-in person with no role there,
--     an API key's session, no user): whether each is a contributor-or-above
--     member and whether their parties match, an oracle on another project's
--     membership. Its callers:
--       - app_share_candidates (049): the caller is always p_owner, a member;
--       - scenario_member_check (049, a trigger): the application's owner
--         adds the share;
--       - project_member_prune_shares (393, a trigger): runs as whoever
--         changes, adds or removes a member, which can be a person with no
--         role left (leaving), or no user at all (the operator's tools, an
--         account deletion's cascade).
--     The rule moves to share_allowed_rule, a plain function only the
--     schema owner (and so the SECURITY DEFINER triggers and functions) can
--     run; the two triggers and app_share_candidates call it, so the internal
--     paths answer as before whoever the caller is. app_share_allowed, the one
--     water_app may call, now answers false unless the caller holds a role in
--     p_project, and is the rule otherwise.
--
--  3. report_delete (023) checked only requested_by = the caller, while
--     report_update also needs viewer. A delete with a WHERE already needed
--     report_select (viewer), so nothing was reachable, but the policy itself
--     let a requester who lost their role delete their old reports with no
--     WHERE. Now as report_update: the requester, while still a viewer.

-- ---------------------------------------------------------------------------
-- 1. delineation_request_final, from 272_plan_request
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION delineation_request_final() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		-- Whose and which project's request it is never changes, queued or not; only the foreign key clears created_by.
		IF (NEW.id, NEW.project_id, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.project_id, OLD.created_at)
			OR (NEW.created_by IS DISTINCT FROM OLD.created_by
				AND (NEW.created_by IS NOT NULL OR EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.created_by))) THEN
			RAISE EXCEPTION 'a delineation request''s id, project, maker and time never change' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.status <> 'queued' AND (
			(NEW.id, NEW.project_id, NEW.status, NEW.click_kind, NEW.click_lon, NEW.click_lat, NEW.keep_point, NEW.from_window,
				NEW.aim, NEW.refusal_code, NEW.refusal, NEW.larger, NEW.created_at, NEW.finished_at, NEW.plan_kind, NEW.plan_body)
			IS DISTINCT FROM
			(OLD.id, OLD.project_id, OLD.status, OLD.click_kind, OLD.click_lon, OLD.click_lat, OLD.keep_point, OLD.from_window,
				OLD.aim, OLD.refusal_code, OLD.refusal, OLD.larger, OLD.created_at, OLD.finished_at, OLD.plan_kind, OLD.plan_body)
			OR (NEW.proposal_id IS DISTINCT FROM OLD.proposal_id AND NEW.proposal_id IS NOT NULL)
			OR (NEW.plan_proposal_id IS DISTINCT FROM OLD.plan_proposal_id AND NEW.plan_proposal_id IS NOT NULL)
			OR (NEW.fallback_proposal_id IS DISTINCT FROM OLD.fallback_proposal_id AND NEW.fallback_proposal_id IS NOT NULL)
			OR (NEW.job_id IS DISTINCT FROM OLD.job_id AND NEW.job_id IS NOT NULL)
		) THEN
			RAISE EXCEPTION 'a delineation request is finished once, and its outcome stays' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
REVOKE ALL ON FUNCTION delineation_request_final() FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- 2. The share rule, and who may ask it
-- ---------------------------------------------------------------------------
-- The rule, from 049's app_share_allowed, unchanged: whether an application
-- owned by p_owner may be shared with p_member. Owner-only: the definer
-- triggers and app_share_candidates call it.
CREATE FUNCTION share_allowed_rule(p_project uuid, p_owner uuid, p_member uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SET search_path = public
	AS $$
	DECLARE
		o record;
		m record;
	BEGIN
		IF p_owner IS NULL OR p_member IS NULL OR p_owner = p_member THEN
			RETURN false;
		END IF;
		SELECT role, party INTO m FROM project_member WHERE project_id = p_project AND user_id = p_member;
		IF NOT FOUND OR m.role < 'contributor'::project_role THEN
			RETURN false;
		END IF;
		SELECT role, party INTO o FROM project_member WHERE project_id = p_project AND user_id = p_owner;
		IF NOT FOUND OR o.role < 'contributor'::project_role THEN
			RETURN false;
		END IF;
		IF o.role >= 'viewer'::project_role THEN
			RETURN true;
		END IF;
		RETURN o.party IS NOT NULL AND m.party IS NOT NULL AND lower(o.party) = lower(m.party);
	END
	$$;
COMMENT ON FUNCTION share_allowed_rule(uuid, uuid, uuid) IS
	'Whether an application owned by p_owner may be shared with p_member (049''s rule; 413). Owner-only: the share triggers and app_share_candidates call it; water_app asks through app_share_allowed.';
REVOKE ALL ON FUNCTION share_allowed_rule(uuid, uuid, uuid) FROM PUBLIC, water_app;

-- app_share_allowed, from 049: false unless the caller holds a role in the project.
CREATE OR REPLACE FUNCTION app_share_allowed(p_project uuid, p_owner uuid, p_member uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF app_current_user_id() IS NULL OR app_project_role(p_project) IS NULL THEN
			RETURN false;
		END IF;
		RETURN share_allowed_rule(p_project, p_owner, p_member);
	END
	$$;
REVOKE ALL ON FUNCTION app_share_allowed(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_share_allowed(uuid, uuid, uuid) TO water_app;

-- app_share_candidates, from 049: the rule directly (the caller is p_owner, so a non-member still gets nothing).
CREATE OR REPLACE FUNCTION app_share_candidates(p_project uuid) RETURNS TABLE (candidate_id uuid, candidate_name text)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT m.user_id, u.display_name
		FROM project_member m JOIN app_user u ON u.id = m.user_id
		WHERE m.project_id = p_project AND share_allowed_rule(p_project, app_current_user_id(), m.user_id)
		ORDER BY u.display_name, m.user_id
	$$;
REVOKE ALL ON FUNCTION app_share_candidates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_share_candidates(uuid) TO water_app;

-- scenario_member_check, from 049: the rule directly (the triggers answer whoever adds the share).
CREATE OR REPLACE FUNCTION scenario_member_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		s record;
	BEGIN
		SELECT project_id, origin, owner_user_id INTO s FROM scenario WHERE id = NEW.scenario_id;
		IF s.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'scenario % belongs to a different project', NEW.scenario_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF s.origin <> 'applicant' THEN
			RAISE EXCEPTION 'only an application is shared this way; a team scenario is read by every viewer' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.user_id = s.owner_user_id THEN
			RAISE EXCEPTION 'the owner already reads their application' USING ERRCODE = 'check_violation';
		END IF;
		IF NOT share_allowed_rule(NEW.project_id, s.owner_user_id, NEW.user_id) THEN
			RAISE EXCEPTION 'user % is not someone this application can be shared with', NEW.user_id USING ERRCODE = 'check_violation';
		END IF;
		IF TG_OP = 'INSERT' THEN
			NEW.added_by := app_current_user_id();
			NEW.added_at := now();
		END IF;
		RETURN NEW;
	END
	$$;
REVOKE ALL ON FUNCTION scenario_member_check() FROM PUBLIC, water_app;

-- project_member_prune_shares, from 393: the rule directly, so a member leaving, or the operator with no user, prunes
-- exactly the shares the rule refuses.
CREATE OR REPLACE FUNCTION project_member_prune_shares() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		p uuid;
		u uuid;
	BEGIN
		IF TG_OP = 'DELETE' THEN
			p := OLD.project_id;
			u := OLD.user_id;
		ELSE
			p := NEW.project_id;
			u := NEW.user_id;
		END IF;
		DELETE FROM scenario_member sm
		USING scenario s
		WHERE s.id = sm.scenario_id AND sm.project_id = p
			AND (sm.user_id = u OR s.owner_user_id = u)
			AND NOT share_allowed_rule(sm.project_id, s.owner_user_id, sm.user_id);
		RETURN NULL;
	END
	$$;
REVOKE ALL ON FUNCTION project_member_prune_shares() FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- 3. report_delete, from 023_reports: as report_update, the requester while still a viewer
-- ---------------------------------------------------------------------------
DROP POLICY report_delete ON report;
CREATE POLICY report_delete ON report FOR DELETE
	USING (requested_by = app_current_user_id() AND app_has_role(project_id, 'viewer'));
