-- 345_plan_keep_picker — the Plan page's live-catchment picker (issue #641 §
-- Downgrade or lapse; docs/billing.md § Pausing after a downgrade). 341 keeps
-- billing_account.kept_project_id (app_billing_keep_catchment) and pauses
-- every other live catchment past Free's limit after the grace, but nothing
-- could list the account's live catchments for its owner to choose from.
--
--   1. app_billing_live_catchments(account): for the account's person or a
--      team admin (app_billing_account_readable, 323; NULL to anyone else),
--      Free's live limit, when the account went over it (the grace's start,
--      over_free_since, and when a pause may start, 14 days on), and each live
--      catchment (338's derived "live") with its name, whether the owner chose
--      it, whether it stays live under 341's order (the chosen one first, else
--      the most recently active), and when it was paused, or null. Names of
--      every catchment billed to the account, whoever's projects they are: the
--      account pays for them, and its owner can only choose among what they can
--      name (docs/billing.md § Choosing the catchment to keep).
--   2. app_billing_keep_live(account, project): the route's write. The project
--      must be one of that account's live catchments (else false, the route's
--      404, the same answer a stranger gets); then 341's
--      app_billing_keep_catchment, which checks the caller again, takes the
--      account's lock and moves the pause at once.
--
-- No table, policy or foreign key: both are definer functions over 323, 338
-- and 341's tables, with search_path pinned.

CREATE FUNCTION app_billing_live_catchments(p_account uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_since timestamptz;
		v_kept uuid;
		v_limit bigint;
		v_list jsonb;
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
		RETURN jsonb_build_object(
			'freeLimit', v_limit,
			'overFreeSince', v_since,
			'pausesFrom', v_since + interval '14 days',
			'catchments', v_list
		);
	END
	$$;
REVOKE ALL ON FUNCTION app_billing_live_catchments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_billing_live_catchments(uuid) TO water_app;
COMMENT ON FUNCTION app_billing_live_catchments(uuid) IS
	'The billing account''s live catchments for its owner''s picker (345, issue #641): Free''s live limit, the grace''s start, and each live catchment with whether it was chosen, stays live and is paused. NULL to anyone but the account''s person or a team admin.';

CREATE FUNCTION app_billing_keep_live(p_account uuid, p_project uuid) RETURNS boolean
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_account IS NULL OR p_project IS NULL OR NOT app_billing_account_readable(p_account) THEN
			RETURN false;
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM project p
			WHERE p.id = p_project AND p.billing_account_id = p_account AND app_project_live_except(p.id, NULL, NULL, NULL, false)
		) THEN
			RETURN false;
		END IF;
		PERFORM app_billing_keep_catchment(p_project);
		RETURN true;
	END
	$$;
REVOKE ALL ON FUNCTION app_billing_keep_live(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_billing_keep_live(uuid, uuid) TO water_app;
COMMENT ON FUNCTION app_billing_keep_live(uuid, uuid) IS
	'The owner keeps one of the account''s live catchments live past Free''s limit (345, issue #641): false unless the caller may and the project is one of the account''s live catchments; else 341''s app_billing_keep_catchment, which moves the pause at once.';
