-- 330_staff_grant — the operator's staff grant of a plan, and its audit log
-- (issue #641 § Enforcement design, "Staff overrides"; docs/billing.md §
-- Staff grants, docs/data-model.md § Billing).
--
-- The operator's tool for manual plans: the first client's deal, founding
-- users, and v1 B2B invoices (a manual Stripe invoice, then a grant). It works
-- with the billing provider unset, and every grant, revocation and expiry is
-- logged.
--
--   1. billing_grant_log: one row per grant, revocation (or replacement) and
--      expiry, never changed (water_app holds SELECT only; only the functions
--      below insert). It goes with its account (ON DELETE CASCADE, so with the
--      person or team, 323). Read by the account's person and its team's
--      admins (app_billing_account_readable, 323): it is the record of their
--      own plan, so the reason is written for them to read.
--   2. app_staff_grant_plan(account, plan, until, reason, by, replace): writes
--      a provider='manual', status 'active' subscription, respecting 323's
--      one-live index. Owner only: caller's rights (not SECURITY DEFINER, so
--      the catalogue's definer guards don't apply) and EXECUTE revoked from
--      PUBLIC and water_app, like 325's report functions.
--        - until: the grant's period_end (NULL: until revoked, a founding
--          user's). With an end, cancel_at_period_end is true, so the renewal
--          notice (329) never picks a grant up and the plan page says it ends.
--        - An account's live subscription already there: a live Stripe one is
--          refused, with or without replace. Ending it here would leave Stripe
--          billing the customer for a plan we no longer show (and 326's
--          app_billing_apply never revives a canceled row), so the operator
--          cancels it in Stripe and the webhook ends it first. A live mock or
--          manual one is refused unless replace is true; replace cancels it
--          (period_end now) and logs a revoke for a manual one.
--        - A lapsed grant on the account (period_end past, not yet expired by
--          the tick) is expired first, so it never blocks a new grant.
--   3. app_staff_revoke_grant(account, reason, by): cancels the account's live
--      manual grant now and logs it. Nothing is deleted; the account drops
--      back to Free (no live subscription, 323).
--   4. app_staff_grant_expire(): the worker's tick (jobs/runner.ts), from the
--      worker's own context only (051's alert_worker_context), moves every
--      live manual grant whose period_end has passed to 'expired' and logs it.
--      "Live" stays 323's status test everywhere else, so a grant can outlive
--      its end by at most one tick (5 minutes in production).

-- ---------------------------------------------------------------------------
-- 1. billing_grant_log
-- ---------------------------------------------------------------------------
CREATE TABLE billing_grant_log (
	id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	billing_account_id uuid NOT NULL REFERENCES billing_account (id) ON DELETE CASCADE,
	subscription_id    uuid REFERENCES subscription (id) ON DELETE SET NULL,
	action             text NOT NULL CHECK (action IN ('grant', 'revoke', 'expire')),
	plan_code          text NOT NULL,
	until              timestamptz,
	reason             text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
	granted_by         text NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 100),
	-- clock_timestamp, not now(): a replace's revoke and the new grant share a transaction and must keep their order.
	created_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX billing_grant_log_account_idx ON billing_grant_log (billing_account_id, created_at);
CREATE INDEX billing_grant_log_subscription_idx ON billing_grant_log (subscription_id);
-- The tick's scan: live grants with an end.
CREATE INDEX subscription_manual_end_idx ON subscription (period_end) WHERE provider = 'manual' AND status = 'active';
COMMENT ON TABLE billing_grant_log IS
	'The staff grant''s audit log (330, issue #641): every grant, revocation and expiry of a manual plan, never changed. Written only by 330''s functions; read by the account''s person and its team''s admins.';
COMMENT ON COLUMN billing_grant_log.granted_by IS
	'Who acted: the operator''s name as they gave it (the script''s --by, else their login), or ''expiry'' for the tick.';

ALTER TABLE billing_grant_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_grant_log_read ON billing_grant_log FOR SELECT USING (app_billing_account_readable(billing_account_id));
GRANT SELECT ON billing_grant_log TO water_app;

-- ---------------------------------------------------------------------------
-- 2. app_staff_grant_plan
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_staff_grant_plan(p_account uuid, p_plan text, p_until timestamptz, p_reason text, p_by text, p_replace boolean DEFAULT false)
	RETURNS uuid
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		v_reason text := btrim(coalesce(p_reason, ''));
		v_by text := btrim(coalesce(p_by, ''));
		v_live subscription;
		v_id uuid;
	BEGIN
		IF NOT EXISTS (SELECT 1 FROM billing_account WHERE id = p_account) THEN
			RAISE EXCEPTION 'no billing account %', p_account USING ERRCODE = 'no_data_found';
		END IF;
		IF p_plan IS NULL OR p_plan = 'free' OR NOT EXISTS (SELECT 1 FROM plan WHERE code = p_plan) THEN
			RAISE EXCEPTION 'grant a paid plan (not %); to end a grant, revoke it', coalesce(p_plan, 'none') USING ERRCODE = 'invalid_parameter_value';
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

		INSERT INTO subscription (billing_account_id, plan_code, status, period_start, period_end, cancel_at_period_end, provider)
		VALUES (p_account, p_plan, 'active', now(), p_until, p_until IS NOT NULL, 'manual')
		RETURNING id INTO v_id;
		INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
		VALUES (p_account, v_id, 'grant', p_plan, p_until, v_reason, v_by);
		RETURN v_id;
	END
	$$;
REVOKE ALL ON FUNCTION app_staff_grant_plan(uuid, text, timestamptz, text, text, boolean) FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- 3. app_staff_revoke_grant
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_staff_revoke_grant(p_account uuid, p_reason text, p_by text) RETURNS uuid
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		v_reason text := btrim(coalesce(p_reason, ''));
		v_by text := btrim(coalesce(p_by, ''));
		v_live subscription;
	BEGIN
		IF length(v_reason) NOT BETWEEN 1 AND 500 THEN
			RAISE EXCEPTION 'give a reason (at most 500 characters)' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF length(v_by) NOT BETWEEN 1 AND 100 THEN
			RAISE EXCEPTION 'say who revokes it (at most 100 characters)' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		SELECT * INTO v_live FROM subscription
			WHERE billing_account_id = p_account AND provider = 'manual' AND status = 'active'
			FOR UPDATE;
		IF v_live.id IS NULL THEN
			RAISE EXCEPTION 'the account has no live staff grant' USING ERRCODE = 'no_data_found';
		END IF;
		UPDATE subscription SET status = 'canceled', period_end = greatest(coalesce(period_start, now()), now()), cancel_at_period_end = false
			WHERE id = v_live.id;
		INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
		VALUES (p_account, v_live.id, 'revoke', v_live.plan_code, now(), v_reason, v_by);
		RETURN v_live.id;
	END
	$$;
REVOKE ALL ON FUNCTION app_staff_revoke_grant(uuid, text, text) FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- 4. app_staff_grant_expire: the worker's tick
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_staff_grant_expire() RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker expires staff grants' USING ERRCODE = 'insufficient_privilege';
		END IF;
		WITH lapsed AS (
			UPDATE subscription SET status = 'expired'
			WHERE provider = 'manual' AND status = 'active' AND period_end <= now()
			RETURNING id, billing_account_id, plan_code, period_end
		)
		INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
		SELECT billing_account_id, id, 'expire', plan_code, period_end, 'the grant reached its end', 'expiry' FROM lapsed;
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;
GRANT EXECUTE ON FUNCTION app_staff_grant_expire() TO water_app;
