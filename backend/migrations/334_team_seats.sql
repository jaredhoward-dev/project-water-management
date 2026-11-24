-- 334_team_seats — one definition of a team's editor seats in use, and the
-- refusal of an editor past the seats a Team plan pays for (issue #641
-- § Who the plan belongs to, Enforcement design, Phase 5; docs/billing.md
-- § Team seats).
--
--   1. app_team_seats_in_use(team): the distinct people holding an editor
--      seat on the team: its members and admins (a team viewer is a viewer),
--      and the direct editors and owners of its projects, each once. The
--      team's projects are those with team_id = team and those billed to the
--      team's account (project_billing_account_set keeps the two the same;
--      the union keeps the count right if they ever part). Viewers,
--      contributors and farmers hold no seat. Owner-only, like 325's metrics
--      functions: not SECURITY DEFINER and no grant to water_app (the catalogue
--      guard wants every definer function callable by water_app), so only
--      the definer functions that run as the owner call it: app_account_plan
--      (which shows the count to who may read the plan) and the seat triggers.
--   2. app_account_plan, redefined from 332 (its latest), reads team.editorCount
--      from it instead of its own copy.
--   3. app_team_seat_guard(team): raises plan_limit when the team's seats in
--      use pass its paid seats: the live Team subscription's `seats`, never
--      fewer than the plan's seats_included. A team with no live subscription
--      (Free) or a live one on another plan has no seat cap here: Team seats
--      are the Team plan's limit, and Free's is per catchment
--      (editors_per_project, a later slice). Off unless the transaction set
--      app.billing_enforced to 'on' (backend/src/db/tx.ts, from
--      BILLING_ENFORCED; nothing in a request sets it). Under
--      pg_advisory_xact_lock(hashtext('billing:' || account)), so two parallel
--      grants of the last seat wait for each other and the second counts the
--      first's: exactly one passes. The count runs after the lock in a fresh
--      READ COMMITTED statement (every write path is READ COMMITTED; withUser's
--      REPEATABLE READ transactions are READ ONLY).
--   4. Triggers that call the guard only for a change that gives someone a
--      seat they didn't already hold:
--        team_member AFTER INSERT OR UPDATE OF role → member or admin;
--        project_member AFTER INSERT OR UPDATE OF role → editor or owner on a
--          team's project;
--        project AFTER UPDATE OF team_id → a project moving into a team brings
--          its direct editors and owners.
--      AFTER, not BEFORE, so an INSERT … ON CONFLICT DO NOTHING that inserts
--      nothing (app_accept_invites for someone already a member) is never
--      refused. Someone already holding a seat on the team (a member promoted
--      to admin, an editor made owner, an editor of another of its projects)
--      costs no new seat, so is never refused, even on a team already over
--      its seats (after a seat reduction).
--
-- The refusal is SQLSTATE 23514 with CONSTRAINT plan_limit and a DETAIL of
-- {"limit": paid seats, "used": the seats in use with the change, "plan": "team"}, which
-- http/errors.ts answers as 402 plan_limit, never with the database's text.
-- No new table, policy or grant to water_app: app_team_seats_in_use,
-- app_team_seat_held and app_team_seat_guard are owner-only (invoker rights,
-- EXECUTE revoked from water_app), reached only through the SECURITY DEFINER
-- triggers and app_account_plan (its grant carries over).

CREATE FUNCTION app_team_seats_in_use(p_team uuid) RETURNS bigint
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	SELECT count(*) FROM (
		SELECT tm.user_id FROM team_member tm
			WHERE tm.team_id = p_team AND tm.role IN ('member', 'admin')
		UNION
		SELECT pm.user_id FROM project_member pm
			WHERE pm.role IN ('editor', 'owner') AND pm.project_id IN (
				SELECT p.id FROM project p WHERE p.team_id = p_team
				UNION
				SELECT p.id FROM project p JOIN billing_account a ON a.id = p.billing_account_id WHERE a.team_id = p_team
			)
	) seats
	$$;
REVOKE ALL ON FUNCTION app_team_seats_in_use(uuid) FROM PUBLIC, water_app;
COMMENT ON FUNCTION app_team_seats_in_use(uuid) IS
	'A team''s editor seats in use (334, issue #641): the distinct team members and admins and direct editors and owners of its projects. Called only by definer functions.';

-- Whether p_user holds a seat on p_team through any row but the one named:
-- p_skip_team skips their team_member row, p_skip_project their project_member
-- row on that project (or, for a project moving into the team, the project).
CREATE FUNCTION app_team_seat_held(p_team uuid, p_user uuid, p_skip_team boolean, p_skip_project uuid) RETURNS boolean
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	SELECT (NOT p_skip_team AND EXISTS (
			SELECT 1 FROM team_member tm WHERE tm.team_id = p_team AND tm.user_id = p_user AND tm.role IN ('member', 'admin')))
		OR EXISTS (
			SELECT 1 FROM project_member pm JOIN project p ON p.id = pm.project_id
			LEFT JOIN billing_account a ON a.id = p.billing_account_id
			WHERE pm.user_id = p_user AND pm.role IN ('editor', 'owner')
			  AND (p.team_id = p_team OR a.team_id = p_team)
			  AND pm.project_id IS DISTINCT FROM p_skip_project)
	$$;
REVOKE ALL ON FUNCTION app_team_seat_held(uuid, uuid, boolean, uuid) FROM PUBLIC, water_app;

-- Raises plan_limit when the team is over its paid seats; a no-op unless
-- billing is enforced and the team's account has a live Team subscription.
-- Called after the row that adds a seat is written, so the count includes it.
CREATE FUNCTION app_team_seat_guard(p_team uuid) RETURNS void
	LANGUAGE plpgsql VOLATILE SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
		v_sub subscription;
		v_paid bigint;
		v_used bigint;
	BEGIN
		IF p_team IS NULL OR coalesce(current_setting('app.billing_enforced', true), '') <> 'on' THEN
			RETURN;
		END IF;
		SELECT id INTO v_account FROM billing_account WHERE team_id = p_team;
		IF v_account IS NULL THEN
			RETURN;
		END IF;
		-- One account's seat grants one after the other (#641 § Where each limit is checked).
		PERFORM pg_advisory_xact_lock(hashtext('billing:' || v_account::text));
		SELECT * INTO v_sub FROM subscription
			WHERE billing_account_id = v_account AND status IN ('trialing', 'active', 'past_due');
		IF v_sub.id IS NULL OR v_sub.plan_code <> 'team' THEN
			RETURN;
		END IF;
		SELECT greatest(coalesce((limits ->> 'seats_included')::bigint, 1), coalesce(v_sub.seats, 0)) INTO v_paid
			FROM plan WHERE code = v_sub.plan_code;
		v_used := app_team_seats_in_use(p_team);
		IF v_used > v_paid THEN
			RAISE EXCEPTION 'plan_limit: the team''s editor seats are all in use'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'plan_limit',
				      DETAIL = jsonb_build_object('limit', v_paid, 'used', v_used, 'plan', v_sub.plan_code)::text;
		END IF;
	END
	$$;
REVOKE ALL ON FUNCTION app_team_seat_guard(uuid) FROM PUBLIC, water_app;
COMMENT ON FUNCTION app_team_seat_guard(uuid) IS
	'Refuses (plan_limit) a team past its paid Team seats, when app.billing_enforced is on (334, issue #641). Called by the seat triggers.';

CREATE FUNCTION team_member_seat_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on'
		   OR NEW.role NOT IN ('member', 'admin')
		   OR (TG_OP = 'UPDATE' AND OLD.role IN ('member', 'admin') AND OLD.team_id = NEW.team_id AND OLD.user_id = NEW.user_id)
		   OR app_team_seat_held(NEW.team_id, NEW.user_id, true, NULL) THEN
			RETURN NULL;
		END IF;
		PERFORM app_team_seat_guard(NEW.team_id);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER team_member_seat_guard AFTER INSERT OR UPDATE OF role ON team_member
	FOR EACH ROW EXECUTE FUNCTION team_member_seat_guard();

CREATE FUNCTION project_member_seat_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_team uuid;
	BEGIN
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on'
		   OR NEW.role NOT IN ('editor', 'owner')
		   OR (TG_OP = 'UPDATE' AND OLD.role IN ('editor', 'owner') AND OLD.project_id = NEW.project_id AND OLD.user_id = NEW.user_id) THEN
			RETURN NULL;
		END IF;
		SELECT coalesce(p.team_id, a.team_id) INTO v_team
			FROM project p LEFT JOIN billing_account a ON a.id = p.billing_account_id
			WHERE p.id = NEW.project_id;
		IF v_team IS NULL OR app_team_seat_held(v_team, NEW.user_id, false, NEW.project_id) THEN
			RETURN NULL;
		END IF;
		PERFORM app_team_seat_guard(v_team);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER project_member_seat_guard AFTER INSERT OR UPDATE OF role ON project_member
	FOR EACH ROW EXECUTE FUNCTION project_member_seat_guard();

-- A project moving into a team: its direct editors and owners join the team's seats.
CREATE FUNCTION project_team_seat_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on'
		   OR NEW.team_id IS NULL OR NEW.team_id IS NOT DISTINCT FROM OLD.team_id THEN
			RETURN NULL;
		END IF;
		IF EXISTS (
			SELECT 1 FROM project_member pm
			WHERE pm.project_id = NEW.id AND pm.role IN ('editor', 'owner')
			  AND NOT app_team_seat_held(NEW.team_id, pm.user_id, false, NEW.id)
		) THEN
			PERFORM app_team_seat_guard(NEW.team_id);
		END IF;
		RETURN NULL;
	END
	$$;
CREATE TRIGGER project_team_seat_guard AFTER UPDATE OF team_id ON project
	FOR EACH ROW EXECUTE FUNCTION project_team_seat_guard();
REVOKE ALL ON FUNCTION team_member_seat_guard(), project_member_seat_guard(), project_team_seat_guard() FROM PUBLIC, water_app;

-- From 332's definition, with team.editorCount from app_team_seats_in_use.
CREATE OR REPLACE FUNCTION app_account_plan(p_account uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_kind text;
		v_plan plan;
		v_sub subscription;
		v_month date := app_billing_month();
		v_utc_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
		v_tokens bigint;
		v_cost bigint;
		v_unpriced bigint;
		v_seats bigint;
		v_cost_limit bigint;
		v_team uuid;
		v_editors bigint;
	BEGIN
		IF NOT app_billing_account_readable(p_account) THEN
			RETURN NULL;
		END IF;
		SELECT kind, team_id INTO v_kind, v_team FROM billing_account WHERE id = p_account;
		-- A team's editor seats in use (334: the one definition, app_team_seats_in_use).
		IF v_kind = 'team' THEN
			v_editors := app_team_seats_in_use(v_team);
		END IF;
		SELECT * INTO v_sub FROM subscription
			WHERE billing_account_id = p_account AND status IN ('trialing', 'active', 'past_due');
		SELECT * INTO v_plan FROM plan WHERE code = coalesce(v_sub.plan_code, 'free');
		-- The account's projects' assistant use in assistant_usage's own (UTC) month (262).
		SELECT coalesce(sum(u.input_tokens + 5 * u.output_tokens), 0), coalesce(sum(u.cost_usd_micros), 0), coalesce(sum(u.unpriced_turns), 0)
			INTO v_tokens, v_cost, v_unpriced
			FROM assistant_usage u JOIN project p ON p.id = u.project_id
			WHERE p.billing_account_id = p_account AND u.month = v_utc_month;
		-- A per-account allowance, else a per-seat one × the seats (the live subscription's, never fewer than included).
		v_cost_limit := (v_plan.limits ->> 'assistant_usd_micros_per_month')::bigint;
		IF v_cost_limit IS NULL AND (v_plan.limits ->> 'assistant_usd_micros_per_seat_month') IS NOT NULL THEN
			v_seats := greatest(coalesce((v_plan.limits ->> 'seats_included')::bigint, 1), coalesce(v_sub.seats, 0));
			v_cost_limit := (v_plan.limits ->> 'assistant_usd_micros_per_seat_month')::bigint * v_seats;
		END IF;
		RETURN jsonb_build_object(
			'account', jsonb_build_object('id', p_account, 'kind', v_kind),
			'plan', jsonb_build_object(
				'code', v_plan.code, 'name', v_plan.name,
				'priceMonthlyMinor', v_plan.price_monthly_minor, 'priceAnnualMinor', v_plan.price_annual_minor,
				'currency', v_plan.currency, 'limits', v_plan.limits, 'features', v_plan.features
			),
			'subscription', CASE WHEN v_sub.id IS NULL THEN NULL ELSE jsonb_build_object(
				'status', v_sub.status, 'seats', v_sub.seats, 'periodStart', v_sub.period_start, 'periodEnd', v_sub.period_end,
				'trialEnd', v_sub.trial_end, 'cancelAtPeriodEnd', v_sub.cancel_at_period_end, 'interval', v_sub.billing_interval
			) END,
			-- A team account's editor count (332); null on a person's.
			'team', CASE WHEN v_kind = 'team' THEN jsonb_build_object('editorCount', v_editors) END,
			'usage', jsonb_build_object(
				'month', to_char(v_month, 'YYYY-MM'),
				-- Every project the account bills (projects have no archived or deleted state yet: a deleted one is gone).
				'catchments', jsonb_build_object(
					'used', (SELECT count(*) FROM project WHERE billing_account_id = p_account),
					'limit', v_plan.limits -> 'catchments'),
				'reports', jsonb_build_object(
					'used', coalesce((SELECT qty FROM usage_counter WHERE billing_account_id = p_account AND kind = 'reports' AND month = v_month), 0),
					'limit', v_plan.limits -> 'reports_per_month'),
				'packsIssued', jsonb_build_object(
					'used', coalesce((SELECT qty FROM usage_counter WHERE billing_account_id = p_account AND kind = 'packs_issued' AND month = v_month), 0),
					'limit', v_plan.limits -> 'packs_included_per_month'),
				-- Weighted tokens (input + 5 × output).
				'assistantTokens', jsonb_build_object('used', v_tokens, 'limit', NULL),
				'assistantCost', jsonb_build_object('usedUsdMicros', v_cost, 'limitUsdMicros', v_cost_limit, 'unpricedTurns', v_unpriced)
			)
		);
	END
	$$;
GRANT EXECUTE ON FUNCTION app_account_plan(uuid) TO water_app;
