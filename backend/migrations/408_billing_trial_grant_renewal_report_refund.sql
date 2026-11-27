-- 408: three billing fixes (issues #930 and #939; docs/billing.md § Staff
-- grants, § Renewal notice, § Shadow mode).
--
--   1. app_staff_grant_plan (latest definition 374) expires a lapsed reverse
--      trial first, as it already expires a lapsed grant (#930 item 1). A
--      trial past its trial_end that the tick (app_reverse_trial_expire, 387)
--      hadn't reached yet stayed 'trialing', so a grant without replace was
--      refused as "already has a live manual subscription" for up to a tick.
--      The trial is expired and logged exactly as 387's tick does it. Same
--      signature: CREATE OR REPLACE keeps 374's owner-only ACL.
--   2. app_renewal_notice_queue (latest definition 329) files a period under
--      its last paid day: the SAST date of the instant before period_end
--      (period_end − 1 µs), not the SAST date of period_end itself (#930
--      item 2). A period ending exactly at SAST midnight named the day after
--      its last paid day, so its business-day count ran one day long. Same
--      signature, ACL kept.
--   3. A report's count is refunded when the report ends failed, and it
--      stays with the account it was counted against (#939 items 2 and 3):
--        - report.usage_account_id / usage_month: the billing account and
--          SAST month the report was counted against when it was queued,
--          written by app_report_count_usage (replacing createReport's
--          app_usage_add call). Cleared on insert (report_usage_clear), so
--          no caller can plant them. A project moved to another account
--          afterwards leaves its queued reports where they were counted.
--        - usage_refunded_at: set when the count was given back.
--        - The three ways a report ends failed (reports/store.ts
--          reportState) each refund it, once: its status set 'failed' (the
--          renderer's failure) or its job gone (report.job_id cleared) while
--          unfinished, by the BEFORE UPDATE trigger report_usage_refund; its
--          job dead (attempts used up), by job_report_usage_refund on job;
--          the renderer silent past the hour's answer window, by the tick's
--          app_report_usage_refund_silent(). A refunded report that then
--          finishes after all (a late answer) is counted again.
--        - The refund goes to the account and month that were counted
--          (never below 0), even when the month has passed or the project
--          moved since.

-- ---------------------------------------------------------------------------
-- 1. The staff grant expires a lapsed trial first
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_staff_grant_plan(p_account uuid, p_plan text, p_until timestamptz, p_reason text, p_by text, p_replace boolean DEFAULT false,
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

		-- 408: a lapsed reverse trial the tick hasn't reached yet, expired and logged as app_reverse_trial_expire (387) does.
		WITH lapsed_trial AS (
			UPDATE subscription SET status = 'expired'
			WHERE billing_account_id = p_account AND provider = 'manual' AND status = 'trialing' AND trial_end <= now()
			RETURNING id, plan_code, trial_end
		)
		INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
		SELECT p_account, id, 'expire', plan_code, trial_end, 'the trial reached its end', 'expiry' FROM lapsed_trial;

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

-- ---------------------------------------------------------------------------
-- 2. The renewal notice is filed under the last paid day
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_renewal_notice_queue(p_from date, p_to date) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker queues renewal notices' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 60
			OR p_from < (now() AT TIME ZONE 'Africa/Johannesburg')::date THEN
			RAISE EXCEPTION 'queue for a range of at most 60 days, from today on' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		INSERT INTO renewal_notice (subscription_id, period_end, user_id)
		SELECT s.id, s.period_end, a.user_id
		FROM subscription s
		JOIN billing_account a ON a.id = s.billing_account_id
		WHERE a.kind = 'user'
		  AND s.status IN ('active', 'past_due')
		  AND NOT s.cancel_at_period_end
		  AND s.period_start IS NOT NULL AND s.period_end IS NOT NULL
		  AND s.period_end - s.period_start >= interval '300 days'
		  -- 408: the last paid day, the SAST date of the instant before the period ends.
		  AND ((s.period_end - interval '1 microsecond') AT TIME ZONE 'Africa/Johannesburg')::date BETWEEN p_from AND p_to
		ON CONFLICT (subscription_id, period_end) DO NOTHING;
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;

-- ---------------------------------------------------------------------------
-- 3. A report's count: where it was counted, and its refund
-- ---------------------------------------------------------------------------
ALTER TABLE report
	ADD COLUMN usage_account_id uuid REFERENCES billing_account (id) ON DELETE SET NULL,
	ADD COLUMN usage_month date,
	ADD COLUMN usage_refunded_at timestamptz;
CREATE INDEX report_usage_account_idx ON report (usage_account_id);
COMMENT ON COLUMN report.usage_account_id IS
	'The billing account this report was counted against when it was queued (408, issue #939): a later move of the project leaves the count here. Written only by app_report_count_usage.';
COMMENT ON COLUMN report.usage_month IS 'The SAST month (first day) the report was counted in (408).';
COMMENT ON COLUMN report.usage_refunded_at IS 'When the count was given back because the report ended failed (408); cleared if it finished after all.';

-- Nobody plants them: water_app may INSERT report rows, so the columns are cleared on insert.
CREATE FUNCTION report_usage_clear() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		NEW.usage_account_id := NULL;
		NEW.usage_month := NULL;
		NEW.usage_refunded_at := NULL;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER report_usage_clear BEFORE INSERT ON report
	FOR EACH ROW EXECUTE FUNCTION report_usage_clear();

-- Add delta (+1 or −1) to an account's reports count for a month, never below 0. Internal: no EXECUTE for anyone, and
-- not SECURITY DEFINER itself; only the definer functions and triggers below call it, with their owner's rights.
CREATE FUNCTION report_usage_adjust(p_account uuid, p_month date, p_delta integer) RETURNS void
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF p_account IS NULL OR p_month IS NULL THEN
			RETURN;
		END IF;
		IF p_delta > 0 THEN
			INSERT INTO usage_counter (billing_account_id, kind, month, qty) VALUES (p_account, 'reports', p_month, p_delta)
				ON CONFLICT (billing_account_id, kind, month) DO UPDATE SET qty = usage_counter.qty + EXCLUDED.qty;
		ELSE
			UPDATE usage_counter SET qty = greatest(qty + p_delta, 0)
			WHERE billing_account_id = p_account AND kind = 'reports' AND month = p_month;
		END IF;
	END
	$$;
REVOKE ALL ON FUNCTION report_usage_adjust(uuid, date, integer) FROM PUBLIC, water_app;

-- Count a report queued in this transaction against its project's account, this SAST month, and record where.
-- The requester only (createReport inserts the row as them, on demand or as a schedule's acting editor); once.
-- Shadow mode, like app_usage_add: never refuses for a limit. A project with no account counts nowhere.
CREATE FUNCTION app_report_count_usage(p_report uuid) RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_project uuid;
		v_account uuid;
		v_month date := app_billing_month();
	BEGIN
		SELECT r.project_id INTO v_project FROM report r
			WHERE r.id = p_report AND r.requested_by = app_current_user_id() AND r.created_at = now() AND r.usage_month IS NULL
			FOR UPDATE;
		IF v_project IS NULL THEN
			RAISE EXCEPTION 'no report of yours queued in this transaction to count' USING ERRCODE = 'insufficient_privilege';
		END IF;
		SELECT billing_account_id INTO v_account FROM project WHERE id = v_project;
		IF v_account IS NULL THEN
			RETURN;
		END IF;
		PERFORM report_usage_adjust(v_account, v_month, 1);
		UPDATE report SET usage_account_id = v_account, usage_month = v_month WHERE id = p_report;
	END
	$$;
REVOKE ALL ON FUNCTION app_report_count_usage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_report_count_usage(uuid) TO water_app;

-- Ways 1 and 2: the report set failed, or its job gone while unfinished (job_id SET NULL); and a refunded report that
-- finishes after all is counted again.
CREATE FUNCTION report_usage_refund() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.usage_month IS NULL THEN
			RETURN NEW;
		END IF;
		IF NEW.usage_refunded_at IS NULL AND (
			(NEW.status = 'failed' AND OLD.status IS DISTINCT FROM 'failed')
			OR (NEW.job_id IS NULL AND OLD.job_id IS NOT NULL AND NEW.status IN ('queued', 'rendering'))
		) THEN
			PERFORM report_usage_adjust(NEW.usage_account_id, NEW.usage_month, -1);
			NEW.usage_refunded_at := now();
		ELSIF NEW.usage_refunded_at IS NOT NULL AND NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
			PERFORM report_usage_adjust(NEW.usage_account_id, NEW.usage_month, 1);
			NEW.usage_refunded_at := NULL;
		END IF;
		RETURN NEW;
	END
	$$;
REVOKE ALL ON FUNCTION report_usage_refund() FROM PUBLIC, water_app;
CREATE TRIGGER report_usage_refund BEFORE UPDATE ON report
	FOR EACH ROW EXECUTE FUNCTION report_usage_refund();

-- Ways 2 and 3 (the shared write): refund unfinished reports by id, once. Internal, as report_usage_adjust.
CREATE FUNCTION report_usage_refund_unfinished(p_reports uuid[]) RETURNS integer
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		n integer := 0;
		r record;
	BEGIN
		FOR r IN
			UPDATE report SET usage_refunded_at = now()
			WHERE id = ANY (p_reports) AND status IN ('queued', 'rendering') AND usage_month IS NOT NULL AND usage_refunded_at IS NULL
			RETURNING usage_account_id, usage_month
		LOOP
			PERFORM report_usage_adjust(r.usage_account_id, r.usage_month, -1);
			n := n + 1;
		END LOOP;
		RETURN n;
	END
	$$;
REVOKE ALL ON FUNCTION report_usage_refund_unfinished(uuid[]) FROM PUBLIC, water_app;

-- Way 2: the report's job dead (its attempts used up).
CREATE FUNCTION job_report_usage_refund() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		PERFORM report_usage_refund_unfinished(ARRAY(SELECT r.id FROM report r WHERE r.job_id = NEW.id));
		RETURN NULL;
	END
	$$;
REVOKE ALL ON FUNCTION job_report_usage_refund() FROM PUBLIC, water_app;
CREATE TRIGGER job_report_usage_refund AFTER UPDATE OF status ON job
	FOR EACH ROW WHEN (NEW.status = 'dead' AND OLD.status IS DISTINCT FROM 'dead' AND NEW.kind = 'report_render')
	EXECUTE FUNCTION job_report_usage_refund();

-- Way 3: a report with the renderer that hasn't answered within the hour (reports/store.ts RENDER_ANSWER_WITHIN_MS,
-- counted from report.sent_at, else from its ask). The worker's tick only.
CREATE FUNCTION app_report_usage_refund_silent() RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker refunds reports' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN report_usage_refund_unfinished(ARRAY(
			SELECT r.id FROM report r
			WHERE r.status = 'rendering' AND r.usage_month IS NOT NULL AND r.usage_refunded_at IS NULL
			  AND coalesce(r.sent_at, r.created_at) < now() - interval '1 hour'
		));
	END
	$$;
REVOKE ALL ON FUNCTION app_report_usage_refund_silent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_report_usage_refund_silent() TO water_app;
