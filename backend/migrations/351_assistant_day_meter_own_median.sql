-- 351_assistant_day_meter_own_median — the day meter's median question is the
-- caller's own, not the account's (operator decision 2026-11-24; docs/billing.md
-- § Assistant dollar caps, docs/ui.md § Assistant).
--
-- 350's median_turn_usd_micros was taken over every member's day rows on the
-- billing account, so any viewer of a Free or trial project could read the
-- account's typical cost of a question. It is now the median of (cost ÷
-- messages) over the caller's own day rows on that account, the same 30 SAST
-- days, the same daily averages, rounded up as before; NULL when the caller has
-- no priced day of their own (the panel then falls back as it does with none:
-- Free's messages left, a trial's share of its day).
--
-- Everything else is 350's definition unchanged: the signature, STABLE,
-- SECURITY DEFINER, the search_path pin, the grants, and every other field.
-- The day's dollars and messages left were already the caller's own.
-- trial_usd_micros_left stays account-wide by nature: the reverse trial's $2 is
-- the account's (app_assistant_begin, 342, counts every member's rows and
-- reservations against it), so a member sees what the account has left of it,
-- the figure that refuses their next turn.

CREATE OR REPLACE FUNCTION app_assistant_day_meter(p_project uuid, p_free_usd_micros_per_day bigint, p_free_messages_per_day integer)
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
			WHERE d.billing_account_id = v_account AND d.user_id = v_user
				AND d.day > v_day - 30 AND d.messages > 0 AND d.cost_usd_micros > 0;

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
