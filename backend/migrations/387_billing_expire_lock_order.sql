-- 387_billing_expire_lock_order — the grant and trial expiry ticks take the
-- billing lock before the row lock (issue #892; docs/billing.md § Staff grants,
-- § Reverse trial).
--
-- 330's app_staff_grant_expire and 342's app_reverse_trial_expire expired
-- every lapsed subscription in one UPDATE. Each row it wrote fired 341's pause
-- sync, which takes 334's billing lock (pg_advisory_xact_lock on 'billing:' ||
-- account) while the tick already held the subscription's row lock. Every
-- other writer takes them the other way round: app_billing_apply, 342's
-- trial start, 344's trial checkout and 374's staff grant take the billing
-- lock first, then the row. So a tick expiring a trial while a paid checkout
-- for the same account ended it could deadlock; Postgres aborts one side, and
-- the webhook answers 500 and is retried (or the tick fails until next time).
--
-- Both functions, created over their only definitions (330, 342), now:
--   1. find the accounts with a lapsed row without locking anything;
--   2. for each, in account id order (so two ticks never cross each other),
--      take the billing lock, then expire that account's lapsed rows, the
--      same WHERE re-checked under the lock (a webhook may have ended the
--      row meanwhile), and log each as before.
-- What they write and return (the rows expired) is unchanged. SECURITY
-- DEFINER, the worker-context check and the grants are kept (CREATE OR
-- REPLACE keeps the function's ACL).

CREATE OR REPLACE FUNCTION app_staff_grant_expire() RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer := 0;
		k integer;
		v_account uuid;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker expires staff grants' USING ERRCODE = 'insufficient_privilege';
		END IF;
		FOR v_account IN
			SELECT DISTINCT billing_account_id FROM subscription
			WHERE provider = 'manual' AND status = 'active' AND period_end <= now()
			ORDER BY billing_account_id
		LOOP
			-- 387: 334's billing lock before the row lock, as 342, 344 and 374 take them.
			PERFORM pg_advisory_xact_lock(hashtext('billing:' || v_account::text));
			WITH lapsed AS (
				UPDATE subscription SET status = 'expired'
				WHERE billing_account_id = v_account AND provider = 'manual' AND status = 'active' AND period_end <= now()
				RETURNING id, billing_account_id, plan_code, period_end
			)
			INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
			SELECT billing_account_id, id, 'expire', plan_code, period_end, 'the grant reached its end', 'expiry' FROM lapsed;
			GET DIAGNOSTICS k = ROW_COUNT;
			n := n + k;
		END LOOP;
		RETURN n;
	END
	$$;

CREATE OR REPLACE FUNCTION app_reverse_trial_expire() RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer := 0;
		k integer;
		v_account uuid;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker expires reverse trials' USING ERRCODE = 'insufficient_privilege';
		END IF;
		FOR v_account IN
			SELECT DISTINCT billing_account_id FROM subscription
			WHERE provider = 'manual' AND status = 'trialing' AND trial_end <= now()
			ORDER BY billing_account_id
		LOOP
			-- 387: 334's billing lock before the row lock, as 342, 344 and 374 take them.
			PERFORM pg_advisory_xact_lock(hashtext('billing:' || v_account::text));
			WITH lapsed AS (
				UPDATE subscription SET status = 'expired'
				WHERE billing_account_id = v_account AND provider = 'manual' AND status = 'trialing' AND trial_end <= now()
				RETURNING id, billing_account_id, plan_code, trial_end
			)
			INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
			SELECT billing_account_id, id, 'expire', plan_code, trial_end, 'the trial reached its end', 'expiry' FROM lapsed;
			GET DIAGNOSTICS k = ROW_COUNT;
			n := n + k;
		END LOOP;
		RETURN n;
	END
	$$;
