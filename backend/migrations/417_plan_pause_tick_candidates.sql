-- 417_plan_pause_tick_candidates — the job tick's plan-pause pass visits only
-- the accounts it can change (issue #641; docs/billing.md § Pausing after a
-- downgrade).
--
-- Before, app_plan_pause_tick (409) called app_plan_pause_sync, every 5
-- minutes, for every account that has had a subscription and has none live.
-- Every account whose reverse trial (342) has ended is one, so the pass grew
-- with all Free accounts, forever: one advisory lock, a handful of lookups
-- and app_live_catchments_in_use (app_project_live_except per project, a
-- definer function the planner can't inline) each. On 10,000 such accounts
-- with 2 projects each it took 2.3-2.5 s in shadow mode and 5-14 s enforced,
-- in one transaction holding each account's billing lock to its end, while
-- for nearly all of them app_plan_pause_sync changed nothing.
--
-- app_plan_pause_sync changes an account only when it has a grace stamp
-- (over_free_since), has a pause marker, or (enforced only) has ended its
-- plan with more live catchments than Free allows. In every other case it
-- updates no row: the stamp is already null and there is no marker to
-- delete. So the tick now visits only those accounts:
--   * a stamp or a marker, as before;
--   * enforced only: an ended plan and more than Free's live catchments,
--     counted in one set-based query. Its "live" is app_project_live_except
--     (338) with nothing skipped, written out so the planner can hash the
--     semi-joins: keep the two in step (plan-pause-tick.db.test.ts checks a
--     catchment live each way is paused).
-- app_plan_pause_sync itself is unchanged and still decides everything under
-- the account's lock. In shadow mode the stamps are cleared first, as in
-- 409, so only accounts with markers remain.
--
-- From 409's definition (its latest). No table, column, policy or grant
-- changes: CREATE OR REPLACE keeps the function's privileges.

CREATE OR REPLACE FUNCTION app_plan_pause_tick() RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
		v_enforced boolean := coalesce(current_setting('app.billing_enforced', true), '') = 'on';
		v_limit bigint;
		n integer := 0;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker pauses catchments' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- 409: in shadow mode no grace clock runs, so a stamp from before (or from enforcement switched off again) goes.
		IF NOT v_enforced THEN
			UPDATE billing_account SET over_free_since = NULL WHERE over_free_since IS NOT NULL;
		END IF;
		-- A marker on a project that no longer bills to an account (its creator's account deleted).
		DELETE FROM project_plan_pause pp USING project p WHERE pp.project_id = p.id AND p.billing_account_id IS NULL;
		SELECT (limits ->> 'live_catchments')::bigint INTO v_limit FROM plan WHERE code = 'free';
		FOR v_account IN
			SELECT b.id FROM billing_account b WHERE b.over_free_since IS NOT NULL
			UNION
			SELECT p.billing_account_id FROM project_plan_pause pp JOIN project p ON p.id = pp.project_id
			WHERE p.billing_account_id IS NOT NULL
			UNION
			-- 417: an ended plan past Free's live catchments (app_plan_pause_sync's grace and pause case), enforced only.
			SELECT p.billing_account_id FROM project p
			WHERE v_enforced AND v_limit IS NOT NULL AND p.billing_account_id IS NOT NULL
			  AND EXISTS (SELECT 1 FROM subscription s WHERE s.billing_account_id = p.billing_account_id)
			  AND NOT EXISTS (SELECT 1 FROM subscription s WHERE s.billing_account_id = p.billing_account_id
			                  AND s.status IN ('trialing', 'active', 'past_due'))
			  -- app_project_live_except(p.id, NULL, NULL, NULL, false), written out (338).
			  AND (EXISTS (SELECT 1 FROM data_feed f WHERE f.project_id = p.id AND f.enabled)
			       OR EXISTS (SELECT 1 FROM alert_rule r WHERE r.project_id = p.id AND r.enabled)
			       OR EXISTS (SELECT 1 FROM run_publication pub WHERE pub.project_id = p.id)
			       OR p.settings -> 'autoRun' ->> 'enabled' = 'true')
			GROUP BY p.billing_account_id
			HAVING count(*) > v_limit
			ORDER BY 1
		LOOP
			n := n + app_plan_pause_sync(v_account);
		END LOOP;
		-- 403: a team back within its seats (editors made viewers, seats bought) clears its marker.
		FOR v_account IN SELECT b.id FROM billing_account b WHERE b.over_seats_since IS NOT NULL ORDER BY b.id LOOP
			PERFORM app_team_seats_sync(v_account);
		END LOOP;
		RETURN n;
	END
	$$;
COMMENT ON FUNCTION app_plan_pause_tick() IS
	'The job tick''s pass over accounts that lost a paid plan (341, issue #641): starts the grace while billing is enforced (409; in shadow mode it clears every grace instead), pauses past it, resumes otherwise. Visits only accounts with a grace stamp, a pause marker, or (enforced) an ended plan past Free''s live catchments (417). Returns the catchments newly paused. Worker context only.';
