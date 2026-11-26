-- 374_staff_grant_seats — a staff grant's seats, and its lock order (issue #641
-- "Staff overrides"; docs/billing.md § Staff grants).
--
-- 330's app_staff_grant_plan wrote every grant with the subscription's default
-- seats, 1, and took no seats argument. On Team (3 seats included) the plan
-- page showed "1 editor seat", and with BILLING_ENFORCED a granted team was
-- capped at the 3 included seats (334's guard counts max(included, seats)),
-- while POST /teams/:id/plan/seats answers a grant with billing_grant_seats,
-- "ask the operator to change its seats with a new grant": a grant the
-- operator had no way to give.
--
-- app_staff_grant_plan, dropped and created from 330's definition (its only
-- one), with:
--   1. p_seats (last, DEFAULT NULL, so every existing positional call keeps
--      working): the editor seats in all. NULL is the plan's seats_included.
--      Fewer than included is refused, and more only on a plan that prices
--      extra seats (Team; Pro sells none), as the B2B invoice refuses them
--      (billing/invoice.ts). At most 100000, app_billing_apply's bound.
--   2. 334's billing lock (pg_advisory_xact_lock on 'billing:' || account)
--      taken before the account row's FOR UPDATE, as 342 and 344 do: the
--      subscription writes below fire 341's sync, which takes that lock, so
--      taking it after the row lock could deadlock against a sync (the tick,
--      a webhook) that holds it and waits for the row.
-- Owner only, as before: caller's rights, EXECUTE revoked from PUBLIC and
-- water_app.

DROP FUNCTION app_staff_grant_plan(uuid, text, timestamptz, text, text, boolean);

CREATE FUNCTION app_staff_grant_plan(p_account uuid, p_plan text, p_until timestamptz, p_reason text, p_by text, p_replace boolean DEFAULT false,
                                     p_seats integer DEFAULT NULL)
	RETURNS uuid
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		v_reason text := btrim(coalesce(p_reason, ''));
		v_by text := btrim(coalesce(p_by, ''));
		v_live subscription;
		v_id uuid;
		v_plan plan;
		v_included integer;
		v_seats integer;
	BEGIN
		IF NOT EXISTS (SELECT 1 FROM billing_account WHERE id = p_account) THEN
			RAISE EXCEPTION 'no billing account %', p_account USING ERRCODE = 'no_data_found';
		END IF;
		SELECT * INTO v_plan FROM plan WHERE code = p_plan;
		IF p_plan IS NULL OR p_plan = 'free' OR v_plan.code IS NULL THEN
			RAISE EXCEPTION 'grant a paid plan (not %); to end a grant, revoke it', coalesce(p_plan, 'none') USING ERRCODE = 'invalid_parameter_value';
		END IF;
		-- 374: the seats, the plan's included ones unless given.
		v_included := coalesce((v_plan.limits ->> 'seats_included')::integer, 1);
		v_seats := coalesce(p_seats, v_included);
		IF v_seats < v_included THEN
			RAISE EXCEPTION 'the % plan includes % seats; grant at least that many', p_plan, v_included USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF v_seats > v_included AND (v_plan.features ->> 'extra_seat_monthly_minor') IS NULL AND (v_plan.features ->> 'extra_seat_annual_minor') IS NULL THEN
			RAISE EXCEPTION 'the % plan sells no extra seats', p_plan USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF v_seats > 100000 THEN
			RAISE EXCEPTION 'grant at most 100000 seats' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF p_until IS NOT NULL AND p_until <= now() THEN
			RAISE EXCEPTION 'a grant ends in the future' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF length(v_reason) NOT BETWEEN 1 AND 500 THEN
			RAISE EXCEPTION 'give a reason (at most 500 characters)' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF length(v_by) NOT BETWEEN 1 AND 100 THEN
			RAISE EXCEPTION 'say who grants it (at most 100 characters)' USING ERRCODE = 'invalid_parameter_value';
		END IF;

		-- One grant at a time per account, against a concurrent grant or webhook (the one-live index is the backstop).
		-- 374: 334's billing lock first, before the row lock, as 342 and 344 take them (341's sync takes it on every
		-- subscription write below).
		PERFORM pg_advisory_xact_lock(hashtext('billing:' || p_account::text));
		PERFORM 1 FROM billing_account WHERE id = p_account FOR UPDATE;

		-- A lapsed grant the tick hasn't reached yet.
		WITH lapsed AS (
			UPDATE subscription SET status = 'expired'
			WHERE billing_account_id = p_account AND provider = 'manual' AND status = 'active' AND period_end <= now()
			RETURNING id, plan_code, period_end
		)
		INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
		SELECT p_account, id, 'expire', plan_code, period_end, 'the grant reached its end', 'expiry' FROM lapsed;

		SELECT * INTO v_live FROM subscription
			WHERE billing_account_id = p_account AND status IN ('trialing', 'active', 'past_due');
		IF v_live.id IS NOT NULL THEN
			IF v_live.provider = 'stripe' THEN
				RAISE EXCEPTION 'the account has a live Stripe subscription (%, %): cancel it in Stripe first; a grant never ends a paid subscription', v_live.plan_code, v_live.status
					USING ERRCODE = 'unique_violation';
			END IF;
			IF NOT coalesce(p_replace, false) THEN
				RAISE EXCEPTION 'the account already has a live % subscription (%): pass replace to end it', v_live.provider, v_live.plan_code
					USING ERRCODE = 'unique_violation';
			END IF;
			UPDATE subscription SET status = 'canceled', period_end = greatest(coalesce(period_start, now()), now()), cancel_at_period_end = false
				WHERE id = v_live.id;
			IF v_live.provider = 'manual' THEN
				INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
				VALUES (p_account, v_live.id, 'revoke', v_live.plan_code, now(), 'replaced: ' || left(v_reason, 489), v_by);
			END IF;
		END IF;

		INSERT INTO subscription (billing_account_id, plan_code, status, seats, period_start, period_end, cancel_at_period_end, provider)
		VALUES (p_account, p_plan, 'active', v_seats, now(), p_until, p_until IS NOT NULL, 'manual')
		RETURNING id INTO v_id;
		INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
		VALUES (p_account, v_id, 'grant', p_plan, p_until, v_reason, v_by);
		RETURN v_id;
	END
	$$;
REVOKE ALL ON FUNCTION app_staff_grant_plan(uuid, text, timestamptz, text, text, boolean, integer) FROM PUBLIC, water_app;
