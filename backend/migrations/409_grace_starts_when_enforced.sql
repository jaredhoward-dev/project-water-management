-- 409_grace_starts_when_enforced — the 14-day grace after a plan ends starts
-- only while billing is enforced (issue #641 § Downgrade or lapse;
-- docs/billing.md § Pausing after a downgrade).
--
-- Before, app_plan_pause_sync (341) stamped billing_account.over_free_since
-- before it looked at app.billing_enforced. A plan that ended in shadow mode
-- (a staff grant's end, a lapsed trial) therefore started its 14 days anyway,
-- and the first tick after enforcement was switched on paused the account at
-- once. 346's queue skips the grace email for a grace already past its 14
-- days, so the owner got only "paused", with no warning.
--
--   1. app_plan_pause_sync, from 341's definition (its only one): with
--      enforcement off it neither stamps nor pauses. It leaves an existing
--      stamp alone, since the subscription trigger also runs it from the
--      schema owner's scripts, which don't carry the setting even when
--      enforcement is on; (2) clears stale stamps. With enforcement on it
--      stamps as before, so the grace (and its email) starts at the first
--      tick after the switch, and nothing pauses for 14 days.
--   2. app_plan_pause_tick, from 403's definition (its latest): with
--      enforcement off (the worker's transactions always carry the setting
--      when it is on, db/tx.ts) it first clears every over_free_since, so a
--      stamp left from before this migration, or from enforcement switched
--      on and off again, never counts towards a later grace.
--   3. app_billing_live_catchments, from 345's definition (its only one),
--      adds planEnded: the account has had a subscription, has none live and
--      is past Free's live catchments, enforced or not. overFreeSince and
--      pausesFrom stay the grace's own dates, null until it starts, so the
--      Plan page can say a plan ended without a pause date that doesn't hold.
--
-- No table, column, policy or grant changes: CREATE OR REPLACE keeps each
-- function's ACL (app_plan_pause_sync owner-only, the tick and the list
-- granted to water_app).

CREATE OR REPLACE FUNCTION app_plan_pause_sync(p_account uuid) RETURNS integer
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
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on' THEN
			-- 409: built but off. No grace clock starts, nothing is paused; the tick clears a stale stamp.
			DELETE FROM project_plan_pause pp USING project p WHERE pp.project_id = p.id AND p.billing_account_id = p_account;
			RETURN 0;
		END IF;
		IF v_since IS NULL THEN
			v_since := now();
			UPDATE billing_account SET over_free_since = v_since WHERE id = p_account;
		END IF;
		IF v_since > now() - interval '14 days' THEN
			-- Still in the grace: recorded, nothing paused.
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
COMMENT ON FUNCTION app_plan_pause_sync(uuid) IS
	'Records the grace and pauses (or resumes) operations on an account''s live catchments past Free''s limit (341, issue #641). The grace starts only while billing is enforced (409), and pauses only once 14 days of it have passed. Called only by definer functions.';

CREATE OR REPLACE FUNCTION app_plan_pause_tick() RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
		n integer := 0;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker pauses catchments' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- 409: in shadow mode no grace clock runs, so a stamp from before (or from enforcement switched off again) goes.
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on' THEN
			UPDATE billing_account SET over_free_since = NULL WHERE over_free_since IS NOT NULL;
		END IF;
		-- A marker on a project that no longer bills to an account (its creator's account deleted).
		DELETE FROM project_plan_pause pp USING project p WHERE pp.project_id = p.id AND p.billing_account_id IS NULL;
		FOR v_account IN
			SELECT b.id FROM billing_account b
			WHERE b.over_free_since IS NOT NULL
			   OR (EXISTS (SELECT 1 FROM subscription s WHERE s.billing_account_id = b.id)
			       AND NOT EXISTS (SELECT 1 FROM subscription s WHERE s.billing_account_id = b.id AND s.status IN ('trialing', 'active', 'past_due')))
			   OR EXISTS (SELECT 1 FROM project_plan_pause pp JOIN project p ON p.id = pp.project_id WHERE p.billing_account_id = b.id)
			ORDER BY b.id
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
	'The job tick''s pass over accounts that lost a paid plan (341, issue #641): starts the grace while billing is enforced (409; in shadow mode it clears every grace instead), pauses past it, resumes otherwise. Returns the catchments newly paused. Worker context only.';

CREATE OR REPLACE FUNCTION app_billing_live_catchments(p_account uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_since timestamptz;
		v_kept uuid;
		v_limit bigint;
		v_list jsonb;
		v_ended boolean;
	BEGIN
		IF p_account IS NULL OR NOT app_billing_account_readable(p_account) THEN
			RETURN NULL;
		END IF;
		SELECT b.over_free_since, b.kept_project_id INTO v_since, v_kept FROM billing_account b WHERE b.id = p_account;
		SELECT (limits ->> 'live_catchments')::bigint INTO v_limit FROM plan WHERE code = 'free';
		-- 341's order (app_plan_pause_sync): the chosen one first, else the most recently active.
		WITH live AS (
			SELECT p.id, p.name, pp.paused_at, row_number() OVER (
				ORDER BY (p.id IS NOT DISTINCT FROM v_kept) DESC,
					greatest(p.updated_at, (SELECT max(r.created_at) FROM model_run r WHERE r.project_id = p.id)) DESC NULLS LAST,
					p.id) AS rn
			FROM project p
			LEFT JOIN project_plan_pause pp ON pp.project_id = p.id
			WHERE p.billing_account_id = p_account AND app_project_live_except(p.id, NULL, NULL, NULL, false)
		)
		SELECT coalesce(jsonb_agg(jsonb_build_object(
				'id', l.id,
				'name', l.name,
				'chosen', l.id IS NOT DISTINCT FROM v_kept,
				'staysLive', v_limit IS NULL OR l.rn <= v_limit,
				'pausedAt', l.paused_at
			) ORDER BY l.rn), '[]'::jsonb)
			INTO v_list FROM live l;
		-- 409: 341's condition for a grace, without enforcement's (in shadow mode no grace starts).
		v_ended := v_limit IS NOT NULL
			AND EXISTS (SELECT 1 FROM subscription s WHERE s.billing_account_id = p_account)
			AND NOT EXISTS (SELECT 1 FROM subscription s WHERE s.billing_account_id = p_account AND s.status IN ('trialing', 'active', 'past_due'))
			AND jsonb_array_length(v_list) > v_limit;
		RETURN jsonb_build_object(
			'freeLimit', v_limit,
			'planEnded', v_ended,
			'overFreeSince', v_since,
			'pausesFrom', v_since + interval '14 days',
			'catchments', v_list
		);
	END
	$$;
COMMENT ON FUNCTION app_billing_live_catchments(uuid) IS
	'The billing account''s live catchments for its owner''s picker (345, issue #641): Free''s live limit, whether a plan ended with the account past it (409), the grace''s start (null until enforced), and each live catchment with whether it was chosen, stays live and is paused. NULL to anyone but the account''s person or a team admin.';
