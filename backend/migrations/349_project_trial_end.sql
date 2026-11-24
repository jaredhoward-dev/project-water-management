-- 349_project_trial_end — the workspace's trial-ending banner (issue #641
-- § Reverse trial; docs/billing.md § The reverse trial, docs/ui.md § The
-- header's notices).
--
-- GET /projects/:id says when the account the catchment is billed to is on a
-- reverse trial (342: a `manual` + `trialing` subscription), so the project
-- header can warn its owner 3 days before the trial ends, beside 341's paused
-- notice. The Plan page reads the same fact from the plan JSON
-- (billing/entitlements.ts accountPlan's `subscription.reverseTrial`).
--
--   app_project_trial_end(project): the reverse trial's trial_end, or NULL
--   when the project's account has none, or when the caller may not read
--   that account (app_billing_account_readable, 323: its person, or an admin
--   of its team). A member who isn't the account's owner sees nothing: the
--   banner is about their plan, not someone else's.
--
-- Inert until REVERSE_TRIAL is on: no trial row exists before then.
-- Read-only; no table, so no RLS, policy or index.

CREATE FUNCTION app_project_trial_end(p_project uuid) RETURNS timestamptz
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
	BEGIN
		SELECT p.billing_account_id INTO v_account FROM project p WHERE p.id = p_project;
		IF v_account IS NULL OR NOT app_billing_account_readable(v_account) THEN
			RETURN NULL;
		END IF;
		RETURN (SELECT s.trial_end FROM subscription s
			WHERE s.billing_account_id = v_account AND s.status = 'trialing' AND s.provider = 'manual'
			ORDER BY s.trial_end DESC NULLS LAST
			LIMIT 1);
	END
	$$;
REVOKE ALL ON FUNCTION app_project_trial_end(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_project_trial_end(uuid) TO water_app;
COMMENT ON FUNCTION app_project_trial_end(uuid) IS
	'When the reverse trial (342: manual + trialing) of the account the project is billed to ends, for that account''s person or a team admin only; NULL otherwise (349, issue #641: the workspace''s trial-ending banner).';
