-- 338_live_catchments — Free's one live catchment: what "live" means for a
-- project, and the refusal of a second one when billing is enforced (issue
-- #641 § Free tier and abuse, Where each limit is checked; docs/billing.md
-- § Live catchments).
--
-- Free never rations modelling. It limits operations to one catchment: data
-- feeds, automatic runs, alerts and published farm views. A project is live
-- when it has any of them switched on, derived from what it already has, with
-- no flag of its own:
--
--   * an enabled data_feed;
--   * an enabled alert_rule;
--   * automatic runs on (project.settings->'autoRun'->>'enabled' = 'true',
--     042's test);
--   * a farm view published (any run_publication: publishing supersedes the
--     old one but keeps it, and farm views stay up with their last
--     publication, so a project that ever published keeps its farm views).
--
-- The owner picks the live catchment by switching those on in it, and moves
-- it by switching them off there (a publication can't be taken back, so a
-- catchment that published stays the live one). Nothing is deleted and
-- nothing already on is switched off by this migration or its guard.
--
--   1. app_project_live_except(project, feed, rule, publication, settings):
--      whether the project is live through anything but the named row (or,
--      with p_skip_settings, but its automatic runs). Owner-only.
--   2. app_live_catchments_in_use(account): the account's projects that are
--      live. Owner-only.
--   3. app_live_catchment_guard(project): raises plan_limit when the
--      project's account is past its plan's live_catchments (Free 1; Pro and
--      Team null, unlimited). No live subscription = Free. Off unless the
--      transaction set app.billing_enforced to 'on' (db/tx.ts). Under 334's
--      pg_advisory_xact_lock(hashtext('billing:' || account)), so two
--      parallel switches on two catchments wait for each other and the second
--      counts the first's: exactly one passes. A project with no billing
--      account (its creator's account deleted) is never refused.
--   4. AFTER triggers that call the guard only when a change makes a project
--      live that wasn't: data_feed and alert_rule (INSERT or UPDATE OF
--      enabled, to true), run_publication (INSERT), project (UPDATE OF
--      settings, automatic runs off → on). A project created with automatic
--      runs on (a copy or an import of a live catchment) is not refused:
--      refusing would ration copying and importing, which Free never limits
--      (docs/followups.md has the durable fix). A change on a project already live
--      is never refused, even on an account already past its limit (after a
--      downgrade, or switched on before enforcement).
--
-- The refusal is 334's: SQLSTATE 23514, CONSTRAINT plan_limit, and a DETAIL of
-- {"limit": the plan's live_catchments, "used": live catchments with the
-- change, "plan": "free", "key": "live_catchments"}, which http/errors.ts
-- answers as 402 plan_limit with fixed words, never the database's text.
-- No new table, policy or grant to water_app: the three functions are
-- owner-only (invoker rights, EXECUTE revoked from water_app), reached only
-- through the SECURITY DEFINER triggers. The counts read data_feed,
-- alert_rule and run_publication by project_id (each covered by an index:
-- data_feed's unique key, alert_rule_key_idx, run_publication's project
-- index) and project by billing_account_id (323's index).

CREATE FUNCTION app_project_live_except(p_project uuid, p_skip_feed uuid, p_skip_rule uuid, p_skip_publication uuid, p_skip_settings boolean)
	RETURNS boolean
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	SELECT EXISTS (SELECT 1 FROM data_feed f WHERE f.project_id = p_project AND f.enabled AND f.id IS DISTINCT FROM p_skip_feed)
		OR EXISTS (SELECT 1 FROM alert_rule r WHERE r.project_id = p_project AND r.enabled AND r.id IS DISTINCT FROM p_skip_rule)
		OR EXISTS (SELECT 1 FROM run_publication pub WHERE pub.project_id = p_project AND pub.id IS DISTINCT FROM p_skip_publication)
		OR (NOT p_skip_settings AND EXISTS (
			SELECT 1 FROM project p WHERE p.id = p_project AND p.settings -> 'autoRun' ->> 'enabled' = 'true'))
	$$;
REVOKE ALL ON FUNCTION app_project_live_except(uuid, uuid, uuid, uuid, boolean) FROM PUBLIC, water_app;
COMMENT ON FUNCTION app_project_live_except(uuid, uuid, uuid, uuid, boolean) IS
	'Whether a project is live (an enabled feed or alert rule, automatic runs on, or a publication) through anything but the named row (338, issue #641). Called only by definer functions.';

CREATE FUNCTION app_live_catchments_in_use(p_account uuid) RETURNS bigint
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	SELECT count(*) FROM project p
	WHERE p.billing_account_id = p_account AND app_project_live_except(p.id, NULL, NULL, NULL, false)
	$$;
REVOKE ALL ON FUNCTION app_live_catchments_in_use(uuid) FROM PUBLIC, water_app;
COMMENT ON FUNCTION app_live_catchments_in_use(uuid) IS
	'The account''s live catchments (338, issue #641): its projects with a feed, an alert, automatic runs or a publication on. Called only by definer functions.';

-- Raises plan_limit when the project's account is past its live catchments;
-- a no-op unless billing is enforced. Called after the row that makes the
-- project live is written, so the count includes it.
CREATE FUNCTION app_live_catchment_guard(p_project uuid) RETURNS void
	LANGUAGE plpgsql VOLATILE SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
		v_plan text;
		v_limit bigint;
		v_used bigint;
	BEGIN
		IF p_project IS NULL OR coalesce(current_setting('app.billing_enforced', true), '') <> 'on' THEN
			RETURN;
		END IF;
		SELECT billing_account_id INTO v_account FROM project WHERE id = p_project;
		IF v_account IS NULL THEN
			RETURN;
		END IF;
		-- One account's limited changes one after the other (334's lock, #641 § Where each limit is checked).
		PERFORM pg_advisory_xact_lock(hashtext('billing:' || v_account::text));
		SELECT coalesce((SELECT s.plan_code FROM subscription s
			WHERE s.billing_account_id = v_account AND s.status IN ('trialing', 'active', 'past_due')), 'free') INTO v_plan;
		SELECT (limits ->> 'live_catchments')::bigint INTO v_limit FROM plan WHERE code = v_plan;
		IF v_limit IS NULL THEN
			RETURN;
		END IF;
		v_used := app_live_catchments_in_use(v_account);
		IF v_used > v_limit THEN
			RAISE EXCEPTION 'plan_limit: the plan''s live catchments are all in use'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'plan_limit',
				      DETAIL = jsonb_build_object('limit', v_limit, 'used', v_used, 'plan', v_plan, 'key', 'live_catchments')::text;
		END IF;
	END
	$$;
REVOKE ALL ON FUNCTION app_live_catchment_guard(uuid) FROM PUBLIC, water_app;
COMMENT ON FUNCTION app_live_catchment_guard(uuid) IS
	'Refuses (plan_limit) a project becoming live past its account''s live_catchments, when app.billing_enforced is on (338, issue #641). Called by the live triggers.';

CREATE FUNCTION data_feed_live_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on'
		   OR NOT NEW.enabled
		   OR (TG_OP = 'UPDATE' AND OLD.enabled AND OLD.project_id = NEW.project_id)
		   OR app_project_live_except(NEW.project_id, NEW.id, NULL, NULL, false) THEN
			RETURN NULL;
		END IF;
		PERFORM app_live_catchment_guard(NEW.project_id);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER data_feed_live_guard AFTER INSERT OR UPDATE OF enabled ON data_feed
	FOR EACH ROW EXECUTE FUNCTION data_feed_live_guard();

CREATE FUNCTION alert_rule_live_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on'
		   OR NOT NEW.enabled
		   OR (TG_OP = 'UPDATE' AND OLD.enabled AND OLD.project_id = NEW.project_id)
		   OR app_project_live_except(NEW.project_id, NULL, NEW.id, NULL, false) THEN
			RETURN NULL;
		END IF;
		PERFORM app_live_catchment_guard(NEW.project_id);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER alert_rule_live_guard AFTER INSERT OR UPDATE OF enabled ON alert_rule
	FOR EACH ROW EXECUTE FUNCTION alert_rule_live_guard();

CREATE FUNCTION run_publication_live_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on'
		   OR app_project_live_except(NEW.project_id, NULL, NULL, NEW.id, false) THEN
			RETURN NULL;
		END IF;
		PERFORM app_live_catchment_guard(NEW.project_id);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER run_publication_live_guard AFTER INSERT ON run_publication
	FOR EACH ROW EXECUTE FUNCTION run_publication_live_guard();

CREATE FUNCTION project_auto_run_live_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on'
		   OR NEW.settings -> 'autoRun' ->> 'enabled' IS DISTINCT FROM 'true'
		   OR OLD.settings -> 'autoRun' ->> 'enabled' = 'true'
		   OR app_project_live_except(NEW.id, NULL, NULL, NULL, true) THEN
			RETURN NULL;
		END IF;
		PERFORM app_live_catchment_guard(NEW.id);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER project_auto_run_live_guard AFTER UPDATE OF settings ON project
	FOR EACH ROW EXECUTE FUNCTION project_auto_run_live_guard();
REVOKE ALL ON FUNCTION data_feed_live_guard(), alert_rule_live_guard(), run_publication_live_guard(), project_auto_run_live_guard()
	FROM PUBLIC, water_app;
