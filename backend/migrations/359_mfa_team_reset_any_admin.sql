-- 359_mfa_team_reset_any_admin — a team admin's reset of a member's second
-- factor refuses anyone who is an admin of any team (operator decision,
-- 2026-11-24; docs/security.md § Two-step sign-in → Recovery).
--
-- app_mfa_team_reset (205, not redefined since) refused only an admin of the
-- team the reset was asked through. Someone who is a plain member of team A
-- and an admin of team B could have their factor stripped at once by A's
-- admin, which then reaches B's projects as their owner: one admin's stolen
-- session in A became a way round B's two-step sign-in. Now the target being
-- an admin of any team is refused ('team_admin', after 'co_admin' for this
-- team's own admins, which keeps its status). Such a person recovers through
-- the self-service reset (an emailed link, then 3 days) or the operator's
-- identity-checked reset (deployment.md § Runbooks 14). The route answers
-- both 403 mfa_reset_admin, with the same words: the caller learns that the
-- person administers some team, never which.
--
-- From 205's definition; only the new check is added. Signature, owner,
-- SECURITY DEFINER, search_path and grants unchanged (CREATE OR REPLACE
-- keeps the grants). No table, policy or grant changes.

CREATE OR REPLACE FUNCTION app_mfa_team_reset(p_team uuid, p_user uuid, p_watermark timestamptz)
	RETURNS TABLE (status text, email citext, locale text)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'app_mfa_team_reset: not allowed' USING ERRCODE = '42501';
		END IF;
		IF app_team_role(p_team) IS DISTINCT FROM 'admin'
			OR NOT EXISTS (SELECT 1 FROM team_member m WHERE m.team_id = p_team AND m.user_id = p_user) THEN
			RETURN QUERY SELECT 'not_found'::text, NULL::citext, NULL::text;
			RETURN;
		END IF;
		IF p_user = uid THEN
			RETURN QUERY SELECT 'self'::text, NULL::citext, NULL::text;
			RETURN;
		END IF;
		IF EXISTS (SELECT 1 FROM team_member m WHERE m.team_id = p_team AND m.user_id = p_user AND m.role = 'admin') THEN
			RETURN QUERY SELECT 'co_admin'::text, NULL::citext, NULL::text;
			RETURN;
		END IF;
		-- An admin of any other team: they own its projects, so they recover
		-- through the self-service reset or the operator, never another team's admin.
		IF EXISTS (SELECT 1 FROM team_member m WHERE m.user_id = p_user AND m.role = 'admin') THEN
			RETURN QUERY SELECT 'team_admin'::text, NULL::citext, NULL::text;
			RETURN;
		END IF;
		IF NOT mfa_has_factor(p_user) THEN
			RETURN QUERY SELECT 'not_enrolled'::text, NULL::citext, NULL::text;
			RETURN;
		END IF;
		PERFORM mfa_remove_factors(p_user, p_watermark);
		INSERT INTO account_security_event (user_id, kind) VALUES (p_user, 'mfa.reset_by_admin');
		RETURN QUERY SELECT 'done'::text, u.email, u.locale::text FROM app_user u WHERE u.id = p_user;
	END
	$$;

COMMENT ON FUNCTION app_mfa_team_reset(uuid, uuid, timestamptz) IS
	'A team admin removes a member''s second factors at once (205); refuses this team''s admins (co_admin) and an admin of any other team (team_admin, 359).';
