-- 337_assistant_sast_day — the Free assistant day is the South African day
-- (00:00 to 24:00 SAST, Africa/Johannesburg, UTC+2 with no daylight saving),
-- as issue #641 states ("Free AI allowance": the day resets at 00:00 SAST),
-- not 336's UTC day (docs/billing.md § Assistant dollar caps).
--
-- What moves to the SAST day:
--   - assistant_day_usage.day and assistant_reservation.day: the day a turn
--     begins (and a charge with no reservation lands) is now
--     (now() AT TIME ZONE 'Africa/Johannesburg')::date (assistant_day_of);
--   - the 'day' refusal, and the 'pool' refusal for a spent day's share: they
--     wait to the next 00:00 SAST (22:00 UTC);
--   - the pool's pacing: the day whose share is worked out is the SAST day.
-- What stays UTC: every month. assistant_usage is keyed by the UTC month
-- (262), and the token caps, the dollar caps' month, a Team member's share,
-- the Free pool's month and the usage the Plan page shows all read it; moving
-- the month would re-key that table and every caller for a 2-hour shift at the
-- month's end. So the pool's "days left" counts SAST days left in the UTC
-- month: assistant_pool_day_allowance gains the month (p_month). Between
-- 22:00 and 24:00 UTC on a UTC month's last day the SAST day is already the
-- next month's first; no SAST day of the UTC month is then left, so the count
-- is 1 (the share is what the month's pool has left, × 2; the month's own cap
-- still binds). From 00:00 UTC (02:00 SAST) on the 1st the month is new, but
-- today's spend still holds the 2 hours before it: the begin floors the
-- month's spend before today at 0, so those 2 hours count against the new
-- month's first day's share (a little less, never more).
--
-- Rows written before this migration: assistant_day_usage and reservation
-- rows keyed by a UTC day are kept as they are and read as the SAST day of
-- the same date. On deploy day D, if it lands before 22:00 UTC the row for D
-- (spend since 00:00 UTC, 02:00 SAST) is read as SAST day D's, so that day
-- misses at most the 2 hours 00:00 to 02:00 SAST that the UTC row for D-1
-- holds; deployed between 22:00 and 24:00 UTC, the SAST day is already D+1
-- and starts empty. Either way at most one day is short by at most 2 hours,
-- once; nothing is rewritten. The purge (app_purge_assistant) is unchanged:
-- it drops day rows before the kept months' first day, which is the same
-- date whichever zone the day was keyed in.
--
-- Started from the latest definitions: app_assistant_begin 12-argument (336),
-- app_assistant_charge 7-argument (336), assistant_pool_day_allowance (336,
-- replaced by a 4-argument form; nothing but the begin called it).
-- assistant_dollars_spent, assistant_settle_expired, the 8-argument begin and
-- the purge take the day as a key and are unchanged.
-- backend/src/assistant/dollarCaps.ts mirrors the day and the pacing (a DB
-- test pins the two together).

COMMENT ON COLUMN assistant_reservation.day IS
	'The SAST day (Africa/Johannesburg) the turn began: the day its cost counts against (337; a UTC day before 337, read as the same date). NULL on a pre-336 reservation.';
COMMENT ON COLUMN assistant_day_usage.day IS
	'A SAST day (Africa/Johannesburg; 337). Rows written before 337 hold a UTC day, read as the SAST day of the same date.';

-- The SAST day an instant falls on, whatever the session's time zone.
CREATE FUNCTION assistant_day_of(p_at timestamptz) RETURNS date
	LANGUAGE sql STABLE SET search_path = public
	AS $$ SELECT (p_at AT TIME ZONE 'Africa/Johannesburg')::date $$;
REVOKE ALL ON FUNCTION assistant_day_of(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant_day_of(timestamptz) TO water_app;

-- The pool's share for a SAST day p_day in the UTC month p_month: (pool left
-- at the day's start ÷ SAST days left in the month, the day included, at
-- least 1) × 2, never below 0. p_spent_before_today is the month's pool spend
-- before the day. dollarCaps.ts poolDayAllowance is the same sum.
CREATE FUNCTION assistant_pool_day_allowance(p_pool bigint, p_spent_before_today bigint, p_day date, p_month date) RETURNS bigint
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
		SELECT greatest(0, floor(
			greatest(0, p_pool - p_spent_before_today)::numeric
			/ greatest(1, (date_trunc('month', p_month) + interval '1 month')::date - p_day)
			* 2
		))::bigint
	$$;
REVOKE ALL ON FUNCTION assistant_pool_day_allowance(bigint, bigint, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant_pool_day_allowance(bigint, bigint, date, date) TO water_app;

-- 336's 12-argument begin, with the SAST day: v_day, the day's wait, and the
-- pool's share in the UTC month (the month's spend before today floored at 0).
CREATE OR REPLACE FUNCTION app_assistant_begin(
	p_project uuid,
	p_tokens_per_month bigint,
	p_messages_per_hour integer,
	p_tokens_per_user_month bigint,
	p_tokens_total_per_month bigint,
	p_max_turn_tokens bigint,
	p_min_turn_tokens bigint,
	p_reservation_seconds integer,
	p_usd_micros_per_token numeric,
	p_free_usd_micros_per_day bigint,
	p_free_messages_per_day integer,
	p_pool_usd_micros_per_month bigint
)
	RETURNS TABLE (outcome text, wait_seconds integer, project_used bigint, user_used bigint, total_used bigint, reservation_id uuid, budget bigint,
		reserved_usd_micros bigint, pool_used_usd_micros bigint, pool_usd_micros bigint)
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
		v_day date := assistant_day_of(now());
		v_enforced boolean := coalesce(current_setting('app.billing_enforced', true), '') = 'on';
		v_month_wait integer;
		v_day_wait integer;
		v_project bigint;
		v_mine bigint;
		v_total bigint;
		v_budget bigint;
		v_id uuid;
		v_rate assistant_rate;
		v_account billing_account;
		v_sub subscription;
		v_plan plan;
		v_free boolean := false;
		v_in_pool boolean := false;
		v_per_seat boolean := false;
		v_limit bigint;
		v_seats bigint;
		v_spent record;
		v_min_usd bigint;
		v_left_day bigint;
		v_left_month bigint;
		v_left_member bigint;
		v_left_pool bigint;
		v_pool_month_left bigint;
		v_usd bigint;
		v_pool_used bigint;
	BEGIN
		IF v_user IS NULL OR p_project IS NULL
			OR p_tokens_per_month IS NULL OR p_tokens_per_month < 1
			OR p_tokens_per_user_month IS NULL OR p_tokens_per_user_month < 1
			OR p_tokens_total_per_month IS NULL OR p_tokens_total_per_month < 1
			OR p_messages_per_hour IS NULL OR p_messages_per_hour < 1
			OR NOT coalesce(app_has_role(p_project, 'viewer'), false) THEN
			RAISE EXCEPTION 'app_assistant_begin: not allowed' USING ERRCODE = '42501';
		END IF;
		IF p_max_turn_tokens IS NULL OR p_min_turn_tokens IS NULL OR p_min_turn_tokens < 1 OR p_max_turn_tokens < p_min_turn_tokens
			OR p_reservation_seconds IS NULL OR p_reservation_seconds < 1 OR p_reservation_seconds > 3600 THEN
			RAISE EXCEPTION 'app_assistant_begin: a turn needs 1 <= min <= max tokens and a reservation of 1 to 3600 seconds' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF p_usd_micros_per_token < 0 OR p_free_usd_micros_per_day < 0 OR p_free_messages_per_day < 0 OR p_pool_usd_micros_per_month < 0 THEN
			RAISE EXCEPTION 'app_assistant_begin: a price or cap below 0' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		-- 264's locks, in its order: every begin's sums (tokens and dollars) are taken one at a time.
		PERFORM pg_advisory_xact_lock(hashtext('assistant_usage:all'));
		PERFORM pg_advisory_xact_lock(hashtext('assistant_usage:' || p_project::text));
		PERFORM assistant_settle_expired();
		DELETE FROM assistant_rate WHERE user_id = v_user AND window_start <= now() - interval '1 hour';
		INSERT INTO assistant_rate (user_id) VALUES (v_user) ON CONFLICT (user_id) DO NOTHING;
		SELECT * INTO v_rate FROM assistant_rate WHERE user_id = v_user FOR UPDATE;
		SELECT s.project_used, s.user_used, s.total_used INTO v_project, v_mine, v_total
			FROM assistant_month_spent(v_month, p_project, v_user) s;
		IF v_rate.messages + 1 > p_messages_per_hour THEN
			RETURN QUERY SELECT 'rate'::text,
				greatest(1, ceil(extract(epoch FROM v_rate.window_start + interval '1 hour' - now())))::integer, v_project, v_mine, v_total, NULL::uuid, NULL::bigint,
				NULL::bigint, NULL::bigint, NULL::bigint;
			RETURN;
		END IF;
		v_month_wait := greatest(1, ceil(extract(epoch FROM ((v_month + interval '1 month')::timestamp AT TIME ZONE 'UTC') - now())))::integer;
		v_day_wait := greatest(1, ceil(extract(epoch FROM ((v_day + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg') - now())))::integer;
		IF p_tokens_total_per_month - v_total < p_min_turn_tokens THEN
			RETURN QUERY SELECT 'total_budget'::text, v_month_wait, v_project, v_mine, v_total, NULL::uuid, NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint;
			RETURN;
		END IF;
		IF p_tokens_per_user_month - v_mine < p_min_turn_tokens THEN
			RETURN QUERY SELECT 'user_budget'::text, v_month_wait, v_project, v_mine, v_total, NULL::uuid, NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint;
			RETURN;
		END IF;
		IF p_tokens_per_month - v_project < p_min_turn_tokens THEN
			RETURN QUERY SELECT 'budget'::text, v_month_wait, v_project, v_mine, v_total, NULL::uuid, NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint;
			RETURN;
		END IF;
		v_budget := least(p_max_turn_tokens, p_tokens_total_per_month - v_total, p_tokens_per_user_month - v_mine, p_tokens_per_month - v_project);

		-- The dollars. A project with no billing account (none yet) has no dollar cap.
		SELECT a.* INTO v_account FROM billing_account a JOIN project p ON p.billing_account_id = a.id WHERE p.id = p_project;
		IF v_account.id IS NOT NULL THEN
			SELECT * INTO v_sub FROM subscription WHERE billing_account_id = v_account.id AND status IN ('trialing', 'active', 'past_due');
			SELECT * INTO v_plan FROM plan WHERE code = coalesce(v_sub.plan_code, 'free');
			v_free := v_plan.code = 'free';
			v_in_pool := v_free OR v_sub.status = 'trialing';
			-- The month's allowance, as app_account_plan (334) works it out.
			v_limit := (v_plan.limits ->> 'assistant_usd_micros_per_month')::bigint;
			IF v_limit IS NULL AND (v_plan.limits ->> 'assistant_usd_micros_per_seat_month') IS NOT NULL THEN
				v_per_seat := true;
				v_seats := greatest(coalesce((v_plan.limits ->> 'seats_included')::bigint, 1), coalesce(v_sub.seats, 0));
				v_limit := (v_plan.limits ->> 'assistant_usd_micros_per_seat_month')::bigint * v_seats;
			END IF;
			SELECT * INTO v_spent FROM assistant_dollars_spent(v_month, v_day, v_account.id, v_user);
			IF v_limit IS NOT NULL THEN
				v_left_month := v_limit - v_spent.account_month;
				IF v_per_seat THEN
					v_left_member := (v_limit * v_account.assistant_member_max_pct) / 100 - v_spent.member_month;
				END IF;
			END IF;
			IF v_free AND p_free_usd_micros_per_day IS NOT NULL THEN
				v_left_day := p_free_usd_micros_per_day - v_spent.member_day;
			END IF;
			IF v_in_pool AND p_pool_usd_micros_per_month IS NOT NULL THEN
				v_pool_used := v_spent.pool_month;
				v_pool_month_left := p_pool_usd_micros_per_month - v_spent.pool_month;
				v_left_pool := least(v_pool_month_left,
					assistant_pool_day_allowance(p_pool_usd_micros_per_month, greatest(0, v_spent.pool_month - v_spent.pool_today), v_day, v_month) - v_spent.pool_today);
			END IF;
			IF v_enforced THEN
				-- What the turn's first call can cost: a cap with less left refuses. With no price, only a spent cap does.
				v_min_usd := CASE WHEN p_usd_micros_per_token IS NULL THEN 1 ELSE ceil(p_min_turn_tokens * p_usd_micros_per_token)::bigint END;
				IF v_free AND p_free_messages_per_day IS NOT NULL AND v_spent.member_day_messages + 1 > p_free_messages_per_day
					OR v_left_day < v_min_usd THEN
					RETURN QUERY SELECT 'day'::text, v_day_wait, v_project, v_mine, v_total, NULL::uuid, NULL::bigint, NULL::bigint, v_pool_used, p_pool_usd_micros_per_month;
					RETURN;
				END IF;
				IF v_left_month < v_min_usd THEN
					RETURN QUERY SELECT 'month'::text, v_month_wait, v_project, v_mine, v_total, NULL::uuid, NULL::bigint, NULL::bigint, v_pool_used, p_pool_usd_micros_per_month;
					RETURN;
				END IF;
				IF v_left_member < v_min_usd THEN
					RETURN QUERY SELECT 'member'::text, v_month_wait, v_project, v_mine, v_total, NULL::uuid, NULL::bigint, NULL::bigint, v_pool_used, p_pool_usd_micros_per_month;
					RETURN;
				END IF;
				IF v_left_pool < v_min_usd THEN
					RETURN QUERY SELECT 'pool'::text, CASE WHEN v_pool_month_left < v_min_usd THEN v_month_wait ELSE v_day_wait END,
						v_project, v_mine, v_total, NULL::uuid, NULL::bigint, NULL::bigint, v_pool_used, p_pool_usd_micros_per_month;
					RETURN;
				END IF;
				-- The budget no more than any dollar cap has left buys at the dearest price (least ignores NULLs).
				IF p_usd_micros_per_token > 0 THEN
					v_budget := least(v_budget,
						floor(v_left_day / p_usd_micros_per_token)::bigint,
						floor(v_left_month / p_usd_micros_per_token)::bigint,
						floor(v_left_member / p_usd_micros_per_token)::bigint,
						floor(v_left_pool / p_usd_micros_per_token)::bigint);
				END IF;
			END IF;
			INSERT INTO assistant_day_usage (billing_account_id, user_id, day, messages) VALUES (v_account.id, v_user, v_day, 1)
				ON CONFLICT (billing_account_id, day, user_id) DO UPDATE SET messages = assistant_day_usage.messages + 1, updated_at = now();
		END IF;
		v_usd := CASE WHEN p_usd_micros_per_token IS NULL THEN NULL ELSE ceil(v_budget * p_usd_micros_per_token)::bigint END;
		UPDATE assistant_rate SET messages = messages + 1 WHERE user_id = v_user;
		INSERT INTO assistant_usage (project_id, user_id, month, messages) VALUES (p_project, v_user, v_month, 1)
			ON CONFLICT (project_id, month, user_id) DO UPDATE SET messages = assistant_usage.messages + 1, updated_at = now();
		INSERT INTO assistant_reservation (project_id, user_id, month, day, reserved, reserved_usd_micros, expires_at)
			VALUES (p_project, v_user, v_month, v_day, v_budget, v_usd, now() + make_interval(secs => p_reservation_seconds))
			RETURNING id INTO v_id;
		RETURN QUERY SELECT 'ok'::text, 0, v_project, v_mine, v_total, v_id, v_budget, v_usd, v_pool_used,
			CASE WHEN v_in_pool THEN p_pool_usd_micros_per_month END;
	END
	$$;
REVOKE ALL ON FUNCTION app_assistant_begin(uuid, bigint, integer, bigint, bigint, bigint, bigint, integer, numeric, bigint, integer, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_begin(uuid, bigint, integer, bigint, bigint, bigint, bigint, integer, numeric, bigint, integer, bigint) TO water_app;

-- 336's 3-argument share keyed the month on the UTC day; only 336's begin called it.
DROP FUNCTION assistant_pool_day_allowance(bigint, bigint, date);

-- 336's 7-argument charge, a charge with no reservation landing on today's SAST day.
CREATE OR REPLACE FUNCTION app_assistant_charge(
	p_project uuid, p_reservation uuid, p_input bigint, p_output bigint,
	p_cache_read bigint, p_cache_write bigint, p_cost_usd_micros bigint
)
	RETURNS TABLE (project_used bigint, user_used bigint, total_used bigint)
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_now_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
		v_month date;
		v_day date := assistant_day_of(now());
		v_res assistant_reservation;
		v_account uuid;
	BEGIN
		IF v_user IS NULL OR p_project IS NULL OR p_input IS NULL OR p_input < 0 OR p_output IS NULL OR p_output < 0
			OR p_cache_read IS NULL OR p_cache_read < 0 OR p_cache_write IS NULL OR p_cache_write < 0
			OR p_cache_read + p_cache_write > p_input OR p_cost_usd_micros < 0 THEN
			RAISE EXCEPTION 'app_assistant_charge: not allowed' USING ERRCODE = '42501';
		END IF;
		IF p_reservation IS NOT NULL THEN
			SELECT * INTO v_res FROM assistant_reservation WHERE id = p_reservation FOR UPDATE;
		END IF;
		IF v_res.id IS NOT NULL THEN
			IF v_res.user_id IS DISTINCT FROM v_user OR v_res.project_id <> p_project THEN
				RAISE EXCEPTION 'app_assistant_charge: not allowed' USING ERRCODE = '42501';
			END IF;
			v_month := v_res.month;
			v_day := coalesce(v_res.day, v_day);
			DELETE FROM assistant_reservation WHERE id = v_res.id;
		ELSE
			IF NOT coalesce(app_has_role(p_project, 'viewer'), false) THEN
				RAISE EXCEPTION 'app_assistant_charge: not allowed' USING ERRCODE = '42501';
			END IF;
			v_month := v_now_month;
		END IF;
		INSERT INTO assistant_usage (project_id, user_id, month, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_micros, unpriced_turns)
			VALUES (p_project, v_user, v_month, p_input, p_output, p_cache_read, p_cache_write, coalesce(p_cost_usd_micros, 0), CASE WHEN p_cost_usd_micros IS NULL THEN 1 ELSE 0 END)
			ON CONFLICT (project_id, month, user_id) DO UPDATE
			SET input_tokens = assistant_usage.input_tokens + EXCLUDED.input_tokens,
				output_tokens = assistant_usage.output_tokens + EXCLUDED.output_tokens,
				cache_read_tokens = assistant_usage.cache_read_tokens + EXCLUDED.cache_read_tokens,
				cache_write_tokens = assistant_usage.cache_write_tokens + EXCLUDED.cache_write_tokens,
				cost_usd_micros = assistant_usage.cost_usd_micros + EXCLUDED.cost_usd_micros,
				unpriced_turns = assistant_usage.unpriced_turns + EXCLUDED.unpriced_turns,
				updated_at = now();
		SELECT billing_account_id INTO v_account FROM project WHERE id = p_project;
		IF v_account IS NOT NULL AND coalesce(p_cost_usd_micros, 0) > 0 THEN
			INSERT INTO assistant_day_usage (billing_account_id, user_id, day, cost_usd_micros) VALUES (v_account, v_user, v_day, p_cost_usd_micros)
				ON CONFLICT (billing_account_id, day, user_id) DO UPDATE
				SET cost_usd_micros = assistant_day_usage.cost_usd_micros + EXCLUDED.cost_usd_micros, updated_at = now();
		END IF;
		RETURN QUERY SELECT * FROM assistant_month_spent(v_now_month, p_project, v_user);
	END
	$$;
