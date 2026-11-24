-- 350_assistant_day_meter — what a capped person has left of today's
-- assistant, for the panel's "questions left today" meter (issue #641
-- follow-up; docs/billing.md § Assistant dollar caps, docs/ui.md § Assistant).
--
-- app_assistant_day_meter(project, Free's dollars a day, Free's messages a day)
-- answers, for the caller on the project's billing account, one row while
-- billing is enforced (app.billing_enforced, as every dollar cap) and the
-- account is on a capped day:
--   kind                    'free' (no live paid plan) or 'trial' (a reverse
--                           trial, 342: subscription_reverse_trial);
--   usd_micros_per_day      Free's day (the argument) or the trial's
--                           (assistant_trial_caps().day_usd_micros);
--   usd_micros_left         that day less the caller's SAST day on the account:
--                           its recorded cost plus every reservation begun
--                           today (assistant_dollars_spent's member_day), at
--                           least 0;
--   messages_left           Free's messages a day less today's, at least 0
--                           (NULL on a trial, which has no message cap);
--   trial_usd_micros_left   the trial's $2 less what app_assistant_begin counts
--                           against it (the account's day rows from the trial's
--                           first SAST day, and its open reservations), at
--                           least 0; NULL on Free;
--   median_turn_usd_micros  the median of (cost ÷ messages) over the account's
--                           day rows of the last 30 SAST days that recorded a
--                           priced turn, rounded up; NULL with none. A day
--                           row's messages are counted at begin and its cost at
--                           charge, so a turn still running makes its day look
--                           cheaper: an estimate, worded as one.
-- No row otherwise: billing off, a paid plan, a project with no account, or a
-- caller who isn't a viewer or above (as app_assistant_used answers NULLs, so
-- a stranger learns nothing). The Free pool is left out: it isn't the
-- person's allowance, and its refusal says so.
--
-- It reads its own sums rather than assistant_dollars_spent, which scans every
-- pool account's month on each call: the status is read every time the
-- assistant panel loads, and needs only this person's day. Read-only (STABLE):
-- it doesn't settle expired reservations as the begin does, so one is counted
-- at its reserved dollars, which is what the settle would charge.

CREATE FUNCTION app_assistant_day_meter(p_project uuid, p_free_usd_micros_per_day bigint, p_free_messages_per_day integer)
	RETURNS TABLE (kind text, usd_micros_per_day bigint, usd_micros_left bigint, messages_left integer,
		trial_usd_micros_left bigint, median_turn_usd_micros bigint)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_day date := assistant_day_of(now());
		v_account uuid;
		v_sub subscription;
		v_trial boolean;
		v_day_usd bigint;
		v_day_msgs bigint;
		v_reserved_today bigint;
		v_trial_left bigint;
		v_median bigint;
		v_caps record;
	BEGIN
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on'
			OR v_user IS NULL OR p_project IS NULL
			OR NOT coalesce(app_has_role(p_project, 'viewer'), false) THEN
			RETURN;
		END IF;
		IF p_free_usd_micros_per_day IS NULL OR p_free_usd_micros_per_day < 0
			OR p_free_messages_per_day IS NULL OR p_free_messages_per_day < 0 THEN
			RAISE EXCEPTION 'app_assistant_day_meter: a cap below 0' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		SELECT p.billing_account_id INTO v_account FROM project p WHERE p.id = p_project;
		IF v_account IS NULL THEN
			RETURN;
		END IF;
		SELECT * INTO v_sub FROM subscription WHERE billing_account_id = v_account AND status IN ('trialing', 'active', 'past_due');
		v_trial := coalesce(subscription_reverse_trial(v_sub.provider, v_sub.status), false);
		-- Capped by the day: Free (no live row, or a live one on the free plan) or a reverse trial.
		IF NOT v_trial AND coalesce(v_sub.plan_code, 'free') <> 'free' THEN
			RETURN;
		END IF;

		SELECT coalesce(sum(d.cost_usd_micros), 0), coalesce(sum(d.messages), 0) INTO v_day_usd, v_day_msgs
			FROM assistant_day_usage d WHERE d.billing_account_id = v_account AND d.user_id = v_user AND d.day = v_day;
		SELECT coalesce(sum(coalesce(r.reserved_usd_micros, 0)), 0) INTO v_reserved_today
			FROM assistant_reservation r JOIN project p ON p.id = r.project_id
			WHERE p.billing_account_id = v_account AND r.user_id = v_user AND r.day = v_day;

		SELECT ceil(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.cost_usd_micros::numeric / d.messages))::bigint INTO v_median
			FROM assistant_day_usage d
			WHERE d.billing_account_id = v_account AND d.day > v_day - 30 AND d.messages > 0 AND d.cost_usd_micros > 0;

		IF v_trial THEN
			SELECT * INTO v_caps FROM assistant_trial_caps();
			-- As app_assistant_begin (342) counts the trial's $2.
			v_trial_left := v_caps.total_usd_micros
				- coalesce((SELECT sum(d.cost_usd_micros) FROM assistant_day_usage d
					WHERE d.billing_account_id = v_account AND d.day >= assistant_day_of(v_sub.period_start)), 0)
				- coalesce((SELECT sum(coalesce(r.reserved_usd_micros, 0)) FROM assistant_reservation r JOIN project p ON p.id = r.project_id
					WHERE p.billing_account_id = v_account), 0);
			RETURN QUERY SELECT 'trial'::text, v_caps.day_usd_micros, greatest(0, v_caps.day_usd_micros - v_day_usd - v_reserved_today),
				NULL::integer, greatest(0, v_trial_left), v_median;
			RETURN;
		END IF;
		RETURN QUERY SELECT 'free'::text, p_free_usd_micros_per_day, greatest(0, p_free_usd_micros_per_day - v_day_usd - v_reserved_today),
			greatest(0, p_free_messages_per_day - v_day_msgs)::integer, NULL::bigint, v_median;
	END
	$$;
REVOKE ALL ON FUNCTION app_assistant_day_meter(uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_day_meter(uuid, bigint, integer) TO water_app;
