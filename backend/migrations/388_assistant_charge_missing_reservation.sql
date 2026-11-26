-- 388_assistant_charge_missing_reservation — app_assistant_charge says when
-- it found no reservation for the id it was given (issue #880).
--
-- A charge whose reservation already expired (and was charged in full as
-- input tokens by a begin's settle or app_purge_assistant) falls through to
-- the no-reservation path and charges again: by design, "counted twice, never
-- too little" (264). Nothing could see how often that happens, and water_app
-- can't read assistant_reservation to tell. The function now returns a fourth
-- column, reservation_missing: true when p_reservation was not NULL and no
-- row had it. The backend (usage.ts chargeTurn) logs
-- `assistant_charge_no_reservation` (no personal data) when it is true
-- (docs/architecture.md § Assistant).
--
-- From 364's definition (the latest), unchanged but for the result. A
-- function's result type can't change in place, so it is dropped and created
-- again with its grants. The extra column is additive: a backend released
-- before this migration selects project_used, user_used, total_used by name
-- and keeps working. The 4-argument wrapper (324) selected *, so it now names
-- its three columns.

DROP FUNCTION app_assistant_charge(uuid, uuid, bigint, bigint, bigint, bigint, bigint);

CREATE FUNCTION app_assistant_charge(
	p_project uuid, p_reservation uuid, p_input bigint, p_output bigint,
	p_cache_read bigint, p_cache_write bigint, p_cost_usd_micros bigint
)
	RETURNS TABLE (project_used bigint, user_used bigint, total_used bigint, reservation_missing boolean)
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
		-- 364: the parent rows this charge's rows (and the counters' rows) reference, then the counter lock when the
		-- charge has a cost to count, and only then the reservation, usage and day rows.
		PERFORM 1 FROM app_user WHERE id = v_user FOR KEY SHARE;
		PERFORM 1 FROM project WHERE id = p_project FOR KEY SHARE;
		SELECT billing_account_id INTO v_account FROM project WHERE id = p_project;
		PERFORM 1 FROM billing_account WHERE id = v_account FOR KEY SHARE;
		IF v_account IS NOT NULL AND coalesce(p_cost_usd_micros, 0) <> 0 THEN
			PERFORM assistant_counter_lock();
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
		-- 388: say whether a reservation id was passed but no row had it (expired and charged in full already).
		RETURN QUERY SELECT s.project_used, s.user_used, s.total_used, (p_reservation IS NOT NULL AND v_res.id IS NULL)
			FROM assistant_month_spent(v_now_month, p_project, v_user) s;
	END
	$$;

REVOKE ALL ON FUNCTION app_assistant_charge(uuid, uuid, bigint, bigint, bigint, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_charge(uuid, uuid, bigint, bigint, bigint, bigint, bigint) TO water_app;

-- As 324's 4-argument form, naming its three columns now that the 7-argument
-- form returns four.
CREATE OR REPLACE FUNCTION app_assistant_charge(p_project uuid, p_reservation uuid, p_input bigint, p_output bigint)
	RETURNS TABLE (project_used bigint, user_used bigint, total_used bigint)
	LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT c.project_used, c.user_used, c.total_used
			FROM app_assistant_charge(p_project, p_reservation, p_input, p_output, 0::bigint, 0::bigint, NULL::bigint) c
	$$;
REVOKE ALL ON FUNCTION app_assistant_charge(uuid, uuid, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_charge(uuid, uuid, bigint, bigint) TO water_app;
