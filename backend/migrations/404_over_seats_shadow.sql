-- 404_over_seats_shadow — a team going over its paid seats is recorded in shadow
-- mode too (issue #926; docs/billing.md § Team seats).
--
-- 403 recorded billing_account.over_seats_since when a subscription's seats
-- changed. With BILLING_ENFORCED off, 334's seat triggers returned before the
-- guard, so an editor added to a team already at (or over) its seats left no
-- record until the next subscription write, and the operator report (which
-- reads the marker) missed it. Redefined from 334 (their only definitions):
--   1. app_team_seat_guard: off, it runs 403's app_team_seats_sync (under the
--      same account lock) instead of returning; on, unchanged (refuses past the
--      paid seats).
--   2. team_member_seat_guard, project_member_seat_guard and
--      project_team_seat_guard: no longer return early when billing is off, so
--      every change that gives someone a new seat reaches the guard either way.
--      The rest of their tests (a role that holds no seat, someone already
--      holding one) still return first, so a change costing no seat takes no
--      lock.
-- No table, policy or grant changes; CREATE OR REPLACE keeps the revoked EXECUTE.

CREATE OR REPLACE FUNCTION app_team_seat_guard(p_team uuid) RETURNS void
	LANGUAGE plpgsql VOLATILE SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
		v_sub subscription;
		v_paid bigint;
		v_used bigint;
	BEGIN
		IF p_team IS NULL THEN
			RETURN;
		END IF;
		SELECT id INTO v_account FROM billing_account WHERE team_id = p_team;
		IF v_account IS NULL THEN
			RETURN;
		END IF;
		-- 404: off (shadow mode), nothing is refused, but a team going over its paid seats is recorded (403's marker).
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on' THEN
			PERFORM app_team_seats_sync(v_account);
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

CREATE OR REPLACE FUNCTION team_member_seat_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.role NOT IN ('member', 'admin')
		   OR (TG_OP = 'UPDATE' AND OLD.role IN ('member', 'admin') AND OLD.team_id = NEW.team_id AND OLD.user_id = NEW.user_id)
		   OR app_team_seat_held(NEW.team_id, NEW.user_id, true, NULL) THEN
			RETURN NULL;
		END IF;
		PERFORM app_team_seat_guard(NEW.team_id);
		RETURN NULL;
	END
	$$;

CREATE OR REPLACE FUNCTION project_member_seat_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_team uuid;
	BEGIN
		IF NEW.role NOT IN ('editor', 'owner')
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

CREATE OR REPLACE FUNCTION project_team_seat_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.team_id IS NULL OR NEW.team_id IS NOT DISTINCT FROM OLD.team_id THEN
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
