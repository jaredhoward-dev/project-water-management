-- 403_over_seats_and_move_pause — a team over its paid seats is recorded, a seat
-- cut and an editor add are ordered by one lock, and a project moving accounts
-- re-syncs both accounts' pause at once (issue #926; docs/billing.md § Team
-- seats, § Pausing after a downgrade).
--
--   1. billing_account.over_seats_since: when a team's live Team subscription
--      was first seen paying for fewer seats than its editors in use (a
--      quantity cut in Stripe's customer portal goes around POST
--      /teams/:id/plan/seats' check). Null when within its seats. Expand only.
--   2. app_team_seats_sync(account): under 334's account lock
--      (pg_advisory_xact_lock(hashtext('billing:' || account))), counts the
--      seats in use in a fresh statement and sets or clears the marker.
--      Owner-only (invoker rights, EXECUTE revoked from water_app), like 334's
--      seat functions.
--   3. subscription_seats_sync: AFTER INSERT OR UPDATE OF seats, status,
--      plan_code ON subscription calls it, so every writer of the seats (the
--      webhook's app_billing_apply, a staff grant, an invoice grant) is checked
--      under the same lock as 334's seat guard. That orders a seat cut against
--      an editor add: the add that commits first is counted by the cut (and
--      the team recorded over its seats); a cut that commits first is read by
--      the add's guard, which then refuses the new editor (enforced). The seat
--      guard already refuses any new seat while seats in use pass the paid
--      seats, so the marker changes no refusal; it is the record the plan page
--      and the operator report read.
--   4. app_plan_pause_tick, redefined from 341 (its only definition), also
--      re-syncs every account marked over its seats, so the marker clears once
--      editors are made viewers or seats bought (nothing else fires then).
--   5. app_account_plan, redefined from 340 (its latest), adds
--      team.overSeats { seats, editors, since } while the editors in use pass a
--      live Team plan's paid seats (worked out now, so it never lags the
--      tick), else null.
--   6. project_billing_move_sync: AFTER UPDATE OF team_id, billing_account_id
--      ON project, when the billing account changed, takes both accounts'
--      locks in id order and runs 341's app_plan_pause_sync and (2) on each:
--      the old account's over_free_since and the moved catchment's pause
--      marker follow the move in the same transaction, not at the next tick.
--      Named to fire before 340's project_move_live_guard and 334's
--      project_team_seat_guard (AFTER triggers fire by name), so the two locks
--      are always taken in id order before either of those takes one.
--
-- No new table or policy. app_account_plan keeps its grant to water_app
-- (CREATE OR REPLACE); the new functions are owner-only or SECURITY DEFINER
-- triggers with EXECUTE revoked.

ALTER TABLE billing_account ADD COLUMN over_seats_since timestamptz;
COMMENT ON COLUMN billing_account.over_seats_since IS
	'When the team''s live Team subscription was first seen paying for fewer editor seats than its editors in use (403, issue #926; a seat cut in the provider''s portal). Null when within its seats.';

CREATE FUNCTION app_team_seats_sync(p_account uuid) RETURNS boolean
	LANGUAGE plpgsql VOLATILE SET search_path = public
	AS $$
	DECLARE
		v_team uuid;
		v_sub subscription;
		v_paid bigint;
		v_over boolean := false;
	BEGIN
		IF p_account IS NULL THEN
			RETURN false;
		END IF;
		SELECT team_id INTO v_team FROM billing_account WHERE id = p_account;
		-- 334's lock: an editor add's seat guard and this count run one after the other.
		PERFORM pg_advisory_xact_lock(hashtext('billing:' || p_account::text));
		IF v_team IS NOT NULL THEN
			SELECT * INTO v_sub FROM subscription
				WHERE billing_account_id = p_account AND status IN ('trialing', 'active', 'past_due');
			IF v_sub.id IS NOT NULL AND v_sub.plan_code = 'team' THEN
				SELECT greatest(coalesce((limits ->> 'seats_included')::bigint, 1), coalesce(v_sub.seats, 0)) INTO v_paid
					FROM plan WHERE code = 'team';
				-- A fresh statement after the lock (READ COMMITTED): counts an editor committed while this waited.
				v_over := app_team_seats_in_use(v_team) > v_paid;
			END IF;
		END IF;
		IF v_over THEN
			UPDATE billing_account SET over_seats_since = now() WHERE id = p_account AND over_seats_since IS NULL;
		ELSE
			UPDATE billing_account SET over_seats_since = NULL WHERE id = p_account AND over_seats_since IS NOT NULL;
		END IF;
		RETURN v_over;
	END
	$$;
REVOKE ALL ON FUNCTION app_team_seats_sync(uuid) FROM PUBLIC, water_app;
COMMENT ON FUNCTION app_team_seats_sync(uuid) IS
	'Records (or clears) a team account paying for fewer Team seats than its editors in use, under 334''s account lock (403, issue #926). Called only by definer functions.';

CREATE FUNCTION subscription_seats_sync() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		PERFORM app_team_seats_sync(NEW.billing_account_id);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER subscription_seats_sync AFTER INSERT OR UPDATE OF seats, status, plan_code ON subscription
	FOR EACH ROW EXECUTE FUNCTION subscription_seats_sync();
REVOKE ALL ON FUNCTION subscription_seats_sync() FROM PUBLIC, water_app;

-- From 341's definition, with the over-seats re-sync.
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
		-- 403: a team back within its seats (editors made viewers, seats bought) clears its marker.
		FOR v_account IN SELECT b.id FROM billing_account b WHERE b.over_seats_since IS NOT NULL LOOP
			PERFORM app_team_seats_sync(v_account);
		END LOOP;
		RETURN n;
	END
	$$;

CREATE FUNCTION project_billing_move_sync() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_first uuid := least(OLD.billing_account_id, NEW.billing_account_id);
		v_second uuid := greatest(OLD.billing_account_id, NEW.billing_account_id);
	BEGIN
		-- Both accounts' locks in id order (least/greatest skip a null), so two moves in opposite directions can't deadlock.
		IF v_first IS NOT NULL THEN
			PERFORM pg_advisory_xact_lock(hashtext('billing:' || v_first::text));
		END IF;
		IF v_second IS NOT NULL AND v_second IS DISTINCT FROM v_first THEN
			PERFORM pg_advisory_xact_lock(hashtext('billing:' || v_second::text));
		END IF;
		PERFORM app_plan_pause_sync(OLD.billing_account_id);
		PERFORM app_plan_pause_sync(NEW.billing_account_id);
		PERFORM app_team_seats_sync(OLD.billing_account_id);
		PERFORM app_team_seats_sync(NEW.billing_account_id);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER project_billing_move_sync AFTER UPDATE OF team_id, billing_account_id ON project
	FOR EACH ROW WHEN (OLD.billing_account_id IS DISTINCT FROM NEW.billing_account_id)
	EXECUTE FUNCTION project_billing_move_sync();
REVOKE ALL ON FUNCTION project_billing_move_sync() FROM PUBLIC, water_app;

-- From 340's definition, with team.overSeats.
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
		v_member_pct smallint;
		v_over_since timestamptz;
		v_paid bigint;
	BEGIN
		IF NOT app_billing_account_readable(p_account) THEN
			RETURN NULL;
		END IF;
		SELECT kind, team_id, assistant_member_max_pct, over_seats_since INTO v_kind, v_team, v_member_pct, v_over_since FROM billing_account WHERE id = p_account;
		-- A team's editor seats in use (334: the one definition, app_team_seats_in_use).
		IF v_kind = 'team' THEN
			v_editors := app_team_seats_in_use(v_team);
		END IF;
		SELECT * INTO v_sub FROM subscription
			WHERE billing_account_id = p_account AND status IN ('trialing', 'active', 'past_due');
		SELECT * INTO v_plan FROM plan WHERE code = coalesce(v_sub.plan_code, 'free');
		-- 403: a live Team plan's paid seats, to say when the editors in use pass them (a seat cut in the provider's portal).
		IF v_kind = 'team' AND v_sub.plan_code = 'team' THEN
			v_paid := greatest(coalesce((v_plan.limits ->> 'seats_included')::bigint, 1), coalesce(v_sub.seats, 0));
		END IF;
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
			-- A team account's editor count (332), its over-seats state (403) and the share of its assistant dollars one member may use (339); null on a person's.
			'team', CASE WHEN v_kind = 'team' THEN jsonb_build_object('editorCount', v_editors, 'assistantMemberMaxPct', v_member_pct,
				-- 403: more editors than the paid seats (now, not only when recorded), since when the subscription was first seen so.
				'overSeats', CASE WHEN v_paid IS NOT NULL AND v_editors > v_paid
					THEN jsonb_build_object('seats', v_paid, 'editors', v_editors, 'since', v_over_since) END) END,
			'usage', jsonb_build_object(
				'month', to_char(v_month, 'YYYY-MM'),
				-- Every project the account bills (projects have no archived or deleted state yet: a deleted one is gone).
				'catchments', jsonb_build_object(
					'used', (SELECT count(*) FROM project WHERE billing_account_id = p_account),
					'limit', v_plan.limits -> 'catchments'),
				-- Its live catchments (338: the one definition, app_live_catchments_in_use); limit null = unlimited.
				'liveCatchments', jsonb_build_object(
					'used', app_live_catchments_in_use(p_account),
					'limit', v_plan.limits -> 'live_catchments'),
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

