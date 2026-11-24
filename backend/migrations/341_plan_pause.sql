-- 341_plan_pause — after a paid plan ends, pause operations on the live
-- catchments past Free's limit, after a 14-day grace (issue #641 § Downgrade
-- or lapse; docs/billing.md § Pausing after a downgrade). Built but off: no
-- catchment is paused unless billing is enforced (app.billing_enforced, set by
-- db/tx.ts from BILLING_ENFORCED).
--
-- #641's rule: nothing is ever deleted, Free never limits modelling, and only
-- operations are over the limit. A pause therefore changes nothing the user
-- set: the catchment's feeds, alert rules, automatic-runs setting and farm
-- views stay as they are, and a marker row (project_plan_pause) makes the
-- scheduler, the alert checks and the automatic runs pass the catchment by.
-- Deleting the marker resumes it exactly as it was. Published farm views stay
-- up (#641: farmers are never cut off by their WUA's billing).
--
--   1. project_plan_pause(project_id, paused_at): the marker. Members read it
--      (RLS, the workspace banner); only the definer functions below write it.
--   2. billing_account.over_free_since: when the account was first seen over
--      Free's live catchments with no live subscription (the grace's start),
--      and billing_account.kept_project_id: the catchment the owner chose to
--      keep live (app_billing_keep_catchment).
--   3. app_plan_pause_sync(account): the one rule. An account that has had a
--      subscription and has none live, with more live catchments (338's
--      app_live_catchments_in_use) than Free allows, gets over_free_since
--      stamped; once 14 days have passed, and only when billing is enforced,
--      every live catchment but Free's limit (the kept one first, else the
--      most recently active: project.updated_at or its newest run) is paused.
--      Otherwise (a live subscription again, back within the limit, never paid,
--      enforcement off, still in the grace) its markers are removed. Owner-only.
--      An account that never had a subscription is never paused: its live
--      catchments predate enforcement or 338 refused the extra ones.
--   4. app_plan_pause_tick(): the job tick's sweep (jobs/runner.ts) over the
--      accounts that may need it; worker context only, like 330's expiry.
--   5. subscription_plan_pause_sync: an AFTER trigger on subscription, so an
--      upgrade resumes at once and a lapse starts the grace at once (the tick
--      also catches both within 5 minutes).
--   6. app_billing_keep_catchment(project): the billing account's owner (the
--      person, or an admin of the team) picks the catchment to keep live.
--   7. app_project_plan_paused(project): when the project was paused, or null;
--      for the app role (the alert queue, the forecast run, the project route).
--   8. From their latest definitions, the paths that start operations skip a
--      paused project: app_due_feeds (322), app_enqueue_rerun (042) and
--      app_alert_schedule (287). The alert queue and the forecast run check
--      app_project_plan_paused in TypeScript (alerts/evaluate.ts alertsOn,
--      runs/autoRun.ts enqueueForecastRun).
--
-- Covering index: project_plan_pause's key is project_id. kept_project_id has
-- no foreign key (see its column).

CREATE TABLE project_plan_pause (
	project_id uuid PRIMARY KEY REFERENCES project (id) ON DELETE CASCADE,
	paused_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE project_plan_pause IS
	'A live catchment whose operations (feeds, alerts, automatic runs) are paused because its billing account dropped to Free past its live catchments and the 14-day grace ran out (341, issue #641). A marker only: deleting it resumes everything as it was. Written only by app_plan_pause_sync.';

ALTER TABLE project_plan_pause ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_plan_pause_read ON project_plan_pause FOR SELECT USING (app_has_role(project_id, 'viewer'));
GRANT SELECT ON project_plan_pause TO water_app;

ALTER TABLE billing_account
	ADD COLUMN over_free_since timestamptz,
	-- No foreign key: every key to project cascades (the catalogue guard), and deleting the kept catchment must not
	-- delete the account. A deleted or moved project's id is simply never among the account's live ones.
	ADD COLUMN kept_project_id uuid;
COMMENT ON COLUMN billing_account.over_free_since IS
	'When the account, with no live subscription after having one, was first seen past Free''s live catchments: the 14-day grace starts here (341). Null when within its plan.';
COMMENT ON COLUMN billing_account.kept_project_id IS
	'The catchment the owner keeps live when the account is past Free''s live catchments (341, app_billing_keep_catchment). Null: the most recently active.';

CREATE FUNCTION app_plan_pause_sync(p_account uuid) RETURNS integer
	LANGUAGE plpgsql VOLATILE SET search_path = public
	AS $$
	DECLARE
		v_since timestamptz;
		v_kept uuid;
		v_limit bigint;
		v_paused integer := 0;
	BEGIN
		IF p_account IS NULL THEN
			RETURN 0;
		END IF;
		-- One account's billing changes one after the other (334's lock).
		PERFORM pg_advisory_xact_lock(hashtext('billing:' || p_account::text));
		SELECT b.over_free_since, b.kept_project_id INTO v_since, v_kept FROM billing_account b WHERE b.id = p_account;
		IF NOT FOUND THEN
			RETURN 0;
		END IF;
		SELECT (limits ->> 'live_catchments')::bigint INTO v_limit FROM plan WHERE code = 'free';
		IF v_limit IS NULL
		   OR EXISTS (SELECT 1 FROM subscription s WHERE s.billing_account_id = p_account AND s.status IN ('trialing', 'active', 'past_due'))
		   OR NOT EXISTS (SELECT 1 FROM subscription s WHERE s.billing_account_id = p_account)
		   OR app_live_catchments_in_use(p_account) <= v_limit THEN
			-- On a plan again, never paid, or back within Free: no grace, nothing paused.
			UPDATE billing_account SET over_free_since = NULL WHERE id = p_account AND over_free_since IS NOT NULL;
			DELETE FROM project_plan_pause pp USING project p WHERE pp.project_id = p.id AND p.billing_account_id = p_account;
			RETURN 0;
		END IF;
		IF v_since IS NULL THEN
			v_since := now();
			UPDATE billing_account SET over_free_since = v_since WHERE id = p_account;
		END IF;
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on' OR v_since > now() - interval '14 days' THEN
			-- Built but off, or still in the grace: the grace is recorded, nothing is paused.
			DELETE FROM project_plan_pause pp USING project p WHERE pp.project_id = p.id AND p.billing_account_id = p_account;
			RETURN 0;
		END IF;
		WITH live AS (
			SELECT p.id, row_number() OVER (
				ORDER BY (p.id IS NOT DISTINCT FROM v_kept) DESC,
					greatest(p.updated_at, (SELECT max(r.created_at) FROM model_run r WHERE r.project_id = p.id)) DESC NULLS LAST,
					p.id) AS rn
			FROM project p
			WHERE p.billing_account_id = p_account AND app_project_live_except(p.id, NULL, NULL, NULL, false)
		), want AS (
			SELECT id FROM live WHERE rn > v_limit
		), resumed AS (
			DELETE FROM project_plan_pause pp USING project p
			WHERE pp.project_id = p.id AND p.billing_account_id = p_account AND pp.project_id NOT IN (SELECT id FROM want)
			RETURNING pp.project_id
		), paused AS (
			INSERT INTO project_plan_pause (project_id) SELECT id FROM want ON CONFLICT (project_id) DO NOTHING
			RETURNING project_id
		)
		SELECT count(*) INTO v_paused FROM paused;
		RETURN v_paused;
	END
	$$;
REVOKE ALL ON FUNCTION app_plan_pause_sync(uuid) FROM PUBLIC, water_app;
COMMENT ON FUNCTION app_plan_pause_sync(uuid) IS
	'Records the grace and pauses (or resumes) operations on an account''s live catchments past Free''s limit (341, issue #641). Pauses only when billing is enforced and 14 days have passed. Called only by definer functions.';

CREATE FUNCTION app_plan_pause_tick() RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
		n integer := 0;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker pauses catchments' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- A marker on a project that no longer bills to an account (its creator's account deleted).
		DELETE FROM project_plan_pause pp USING project p WHERE pp.project_id = p.id AND p.billing_account_id IS NULL;
		FOR v_account IN
			SELECT b.id FROM billing_account b
			WHERE b.over_free_since IS NOT NULL
			   OR (EXISTS (SELECT 1 FROM subscription s WHERE s.billing_account_id = b.id)
			       AND NOT EXISTS (SELECT 1 FROM subscription s WHERE s.billing_account_id = b.id AND s.status IN ('trialing', 'active', 'past_due')))
			   OR EXISTS (SELECT 1 FROM project_plan_pause pp JOIN project p ON p.id = pp.project_id WHERE p.billing_account_id = b.id)
		LOOP
			n := n + app_plan_pause_sync(v_account);
		END LOOP;
		RETURN n;
	END
	$$;
REVOKE ALL ON FUNCTION app_plan_pause_tick() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_plan_pause_tick() TO water_app;
COMMENT ON FUNCTION app_plan_pause_tick() IS
	'The job tick''s pass over accounts that lost a paid plan (341, issue #641): starts the grace, pauses past it when enforced, resumes otherwise. Returns the catchments newly paused. Worker context only.';

CREATE FUNCTION subscription_plan_pause_sync() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		PERFORM app_plan_pause_sync(NEW.billing_account_id);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER subscription_plan_pause_sync AFTER INSERT OR UPDATE OF status ON subscription
	FOR EACH ROW EXECUTE FUNCTION subscription_plan_pause_sync();
REVOKE ALL ON FUNCTION subscription_plan_pause_sync() FROM PUBLIC, water_app;

CREATE FUNCTION app_billing_keep_catchment(p_project uuid) RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
	BEGIN
		SELECT p.billing_account_id INTO v_account FROM project p WHERE p.id = p_project;
		-- Not the caller's account (or no such project): the same answer, so it says nothing about the project.
		IF v_account IS NULL OR NOT app_billing_account_readable(v_account) THEN
			RAISE EXCEPTION 'not a catchment of your billing account' USING ERRCODE = 'no_data_found';
		END IF;
		-- 334's lock before the write, as app_plan_pause_sync takes it: the UPDATE's row lock first would
		-- deadlock against a sync (the tick, a subscription change) that holds the advisory lock and writes the row.
		PERFORM pg_advisory_xact_lock(hashtext('billing:' || v_account::text));
		UPDATE billing_account SET kept_project_id = p_project WHERE id = v_account;
		PERFORM app_plan_pause_sync(v_account);
	END
	$$;
REVOKE ALL ON FUNCTION app_billing_keep_catchment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_billing_keep_catchment(uuid) TO water_app;
COMMENT ON FUNCTION app_billing_keep_catchment(uuid) IS
	'The billing account''s owner picks the catchment that stays live past Free''s limit (341, issue #641); the pause moves at once.';

CREATE FUNCTION app_project_plan_paused(p_project uuid) RETURNS timestamptz
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	SELECT paused_at FROM project_plan_pause WHERE project_id = p_project
	$$;
REVOKE ALL ON FUNCTION app_project_plan_paused(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_project_plan_paused(uuid) TO water_app;
COMMENT ON FUNCTION app_project_plan_paused(uuid) IS
	'When the project''s operations were paused past Free''s limit, or null (341). A boolean''s worth: says nothing but the pause, so the worker paths (no user) can ask too.';

-- From 322's definition: a paused project's feeds are not scheduled.
CREATE OR REPLACE FUNCTION app_due_feeds(p_limit integer, p_all boolean DEFAULT false, p_projects uuid[] DEFAULT NULL)
	RETURNS TABLE (id uuid, project_id uuid, acting_user_id uuid)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
			RAISE EXCEPTION 'list 1–500 feeds' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		RETURN QUERY
		SELECT f.id, f.project_id, f.acting_user_id FROM data_feed f
		WHERE f.enabled AND f.acting_user_id IS NOT NULL
		  AND (p_projects IS NULL OR f.project_id = ANY (p_projects))
		  AND NOT EXISTS (SELECT 1 FROM project_plan_pause pp WHERE pp.project_id = f.project_id)
		  AND (p_all OR (app_feed_is_due(f.source, f.schedule, f.consecutive_failures, f.last_scheduled_at, now(), f.last_error)
		                 AND NOT app_feed_fetch_out(f.fetch_job_id, now())))
		ORDER BY f.last_scheduled_at NULLS FIRST, f.id
		LIMIT p_limit;
	END
	$$;

-- From 042's definition: a paused project queues no automatic re-run.
CREATE OR REPLACE FUNCTION app_enqueue_rerun(p_project uuid, p_cause text)
	RETURNS TABLE (job_id uuid, due_at timestamptz, created boolean)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_actor uuid := app_rerun_acting_user(p_project);
		v_auto jsonb;
		v_debounce interval;
		v_max_wait constant interval := interval '120 minutes';
	BEGIN
		IF v_actor IS NULL THEN
			-- A live key of this project whose creator's account was deleted:
			-- skip the re-run, never roll the key's ingest back.
			IF app_current_user_id() IS NULL AND app_api_key_project('series:write') = p_project THEN
				RETURN;
			END IF;
			RAISE EXCEPTION 'only an editor of the project can queue a re-run' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_cause IS NULL OR p_cause NOT IN ('series', 'feed', 'ingest') THEN
			RAISE EXCEPTION 'unknown re-run cause' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		SELECT p.settings->'autoRun' INTO v_auto FROM project p WHERE p.id = p_project;
		IF v_auto IS NULL OR jsonb_typeof(v_auto) <> 'object' OR (v_auto->'enabled') IS DISTINCT FROM 'true'::jsonb THEN
			RETURN;
		END IF;
		-- Paused past Free's limit (341): the setting stays on, the runs wait for the resume.
		IF EXISTS (SELECT 1 FROM project_plan_pause pp WHERE pp.project_id = p_project) THEN
			RETURN;
		END IF;
		v_debounce := make_interval(mins => CASE
			WHEN jsonb_typeof(v_auto->'debounceMinutes') = 'number'
				AND (v_auto->>'debounceMinutes')::numeric BETWEEN 0 AND 120
				AND (v_auto->>'debounceMinutes')::numeric = trunc((v_auto->>'debounceMinutes')::numeric)
			THEN (v_auto->>'debounceMinutes')::integer ELSE 15 END);
		-- One enqueue at a time per project, to the end of the caller's
		-- transaction: two merges committing together each saw no pending
		-- job and queued one, and the loser's insert then hit the dedupe index.
		PERFORM pg_advisory_xact_lock(hashtextextended('job_rerun:' || p_project::text, 0));

		RETURN QUERY
			UPDATE job j SET run_after = LEAST(now() + v_debounce, j.created_at + v_max_wait),
				payload = jsonb_set(j.payload, '{cause}', to_jsonb(p_cause))
			WHERE j.project_id = p_project AND j.dedupe_key = 'rerun' AND j.status = 'queued' AND j.payload->>'trigger' = 'auto'
			RETURNING j.id, j.run_after, false;
		IF FOUND THEN RETURN; END IF;

		RETURN QUERY
			SELECT j.id, j.run_after, false FROM job j
			WHERE j.project_id = p_project AND j.dedupe_key = 'rerun' AND j.status IN ('queued', 'failed');
		IF FOUND THEN RETURN; END IF;

		-- job_enqueue stamps a signed-in caller as the acting user (v_actor is
		-- that user then), and takes v_actor as given for a key (see 4).
		-- ON CONFLICT: a manual re-run (POST /jobs, which doesn't take the lock) queued in between.
		RETURN QUERY
			INSERT INTO job AS j (project_id, kind, payload, dedupe_key, run_after, acting_user_id)
			VALUES (p_project, 'rerun', jsonb_build_object('label', '', 'trigger', 'auto', 'cause', p_cause), 'rerun', now() + v_debounce, v_actor)
			ON CONFLICT (project_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'failed') DO NOTHING
			RETURNING j.id, j.run_after, true;
		IF FOUND THEN RETURN; END IF;

		RETURN QUERY
			SELECT j.id, j.run_after, false FROM job j
			WHERE j.project_id = p_project AND j.dedupe_key = 'rerun' AND j.status IN ('queued', 'failed');
	END
	$$;

-- From 287's definition: a paused project's alert checks are not scheduled.
CREATE OR REPLACE FUNCTION app_alert_schedule(p_project uuid, p_gap interval, p_limit integer) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker schedules alert checks' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_gap IS NULL OR p_gap < interval '0' OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
			RAISE EXCEPTION 'a gap ≥ 0 and 1–1000 projects' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		WITH due AS (
			SELECT p.id FROM project p
			WHERE (p_project IS NULL OR p.id = p_project)
			  AND NOT EXISTS (SELECT 1 FROM project_plan_pause pp WHERE pp.project_id = p.id)
			  AND EXISTS (SELECT 1 FROM alert_rule r WHERE r.project_id = p.id AND r.enabled
				AND (p_project IS NOT NULL OR r.kind IN ('data_stale', 'feed_failing', 'job_dead', 'ewr_forecast_fail')))
			  AND NOT EXISTS (
				SELECT 1 FROM job j WHERE j.project_id = p.id AND j.kind = 'alert_eval'
				  AND (j.status IN ('queued', 'failed') OR j.created_at > now() - p_gap))
			ORDER BY p.id
			LIMIT p_limit
		), actor AS (
			SELECT d.id AS project_id, (
				SELECT c.uid FROM (
					SELECT r.created_by AS uid, 1 AS o, r.created_at AS at FROM alert_rule r
					WHERE r.project_id = d.id AND r.enabled AND r.created_by IS NOT NULL
					UNION ALL
					SELECT f.acting_user_id, 2, f.created_at FROM data_feed f WHERE f.project_id = d.id AND f.acting_user_id IS NOT NULL
					UNION ALL
					SELECT m.user_id, 3, m.added_at FROM project_member m WHERE m.project_id = d.id AND m.role = 'owner'
				) c
				WHERE alert_user_role(d.id, c.uid) >= 'editor'
				ORDER BY c.o, c.at
				LIMIT 1
			) AS uid
			FROM due d
		)
		INSERT INTO job (project_id, kind, payload, dedupe_key, acting_user_id)
			SELECT a.project_id, 'alert_eval', jsonb_build_object('cause', 'schedule'), 'alert_eval', a.uid
			FROM actor a WHERE a.uid IS NOT NULL
			ON CONFLICT (project_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'failed') DO NOTHING;
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;
