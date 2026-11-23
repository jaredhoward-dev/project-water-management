-- 324_assistant_turn_cost — what each assistant turn cost in dollars, recorded
-- (issue #641 Phase 1, shadow mode; docs/architecture.md § Assistant,
-- docs/data-model.md § assistant_usage).
--
-- The caps count weighted tokens (input + 5 × output, 262), which is money
-- only at one model's input price, and they count prompt-cache reads and
-- writes as plain input although Bedrock bills a read at a tenth of it or
-- less and a write at a quarter more. Dollar allowances per plan (#641) need the
-- real cost, so each turn's is now worked out by the backend
-- (assistant/pricing.ts: a per-model price table, input, output, cache reads
-- and cache writes priced apart, rounded up to a whole micro-USD) and added
-- to the turn's usage row with its cache tokens. Nothing reads it to refuse
-- a turn yet: the caps are unchanged.
--
-- assistant_usage gains, all summed per person, project and month like the
-- token counts:
--   - cache_read_tokens, cache_write_tokens: the part of input_tokens read
--     from and written to the prompt cache (input_tokens still counts every
--     input token, as the caps do);
--   - cost_usd_micros: the turns' cost in micro-USD (1 USD = 1 000 000);
--   - unpriced_turns: turns whose cost isn't in cost_usd_micros (a model the
--     price table doesn't have, a charge from a backend older than this
--     migration, or a reservation charged in full because its turn never
--     settled), so the month's cost is known to be a floor when it isn't 0.
--
-- app_assistant_charge (latest: 264) gets a 7-argument form that takes the
-- cache tokens and the cost (NULL: unpriced). The 4-argument form stays, as
-- that form with no cache tokens and no cost, so a backend released before
-- this migration keeps charging (expand; it goes once no release calls it).
-- assistant_settle_expired (latest: 264) counts each reservation it charges
-- as an unpriced turn. RLS and grants are unchanged: members still read only
-- their own rows (262 assistant_usage_own), and the new columns come with the
-- table's SELECT grant.

ALTER TABLE assistant_usage
	ADD COLUMN cache_read_tokens  bigint  NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
	ADD COLUMN cache_write_tokens bigint  NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
	ADD COLUMN cost_usd_micros    bigint  NOT NULL DEFAULT 0 CHECK (cost_usd_micros >= 0),
	ADD COLUMN unpriced_turns     integer NOT NULL DEFAULT 0 CHECK (unpriced_turns >= 0);
COMMENT ON COLUMN assistant_usage.cache_read_tokens IS 'The part of input_tokens read from the prompt cache (324).';
COMMENT ON COLUMN assistant_usage.cache_write_tokens IS 'The part of input_tokens written to the prompt cache (324).';
COMMENT ON COLUMN assistant_usage.cost_usd_micros IS
	'The priced turns'' cost in micro-USD, from assistant/pricing.ts (324). Recorded only: no cap reads it yet.';
COMMENT ON COLUMN assistant_usage.unpriced_turns IS
	'Turns not in cost_usd_micros: an unpriced model, a pre-324 charge, or an expired reservation charged in full (324).';

-- As 264, and each reservation it converts counted as an unpriced turn.
CREATE OR REPLACE FUNCTION assistant_settle_expired() RETURNS integer
	LANGUAGE plpgsql VOLATILE SET search_path = public
	AS $$
	DECLARE
		v_n integer;
	BEGIN
		WITH gone AS (
			DELETE FROM assistant_reservation WHERE expires_at <= now() RETURNING project_id, user_id, month, reserved
		), per_row AS (
			SELECT project_id, user_id, month, sum(reserved)::bigint AS reserved, count(*)::integer AS n FROM gone GROUP BY project_id, user_id, month
		), charged AS (
			-- Runs whether or not the query below reads it (a data-modifying WITH always runs to completion).
			INSERT INTO assistant_usage (project_id, user_id, month, input_tokens, unpriced_turns)
			SELECT project_id, user_id, month, reserved, n FROM per_row
			ON CONFLICT (project_id, month, user_id) DO UPDATE
				SET input_tokens = assistant_usage.input_tokens + EXCLUDED.input_tokens,
					unpriced_turns = assistant_usage.unpriced_turns + EXCLUDED.unpriced_turns,
					updated_at = now()
		)
		SELECT coalesce(sum(n), 0)::integer INTO v_n FROM per_row;
		RETURN v_n;
	END
	$$;
REVOKE ALL ON FUNCTION assistant_settle_expired() FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_settle_expired() FROM water_app;

-- As 264's app_assistant_charge, with the turn's cache tokens (the part of
-- p_input read from and written to the cache, together no more than p_input)
-- and its cost in micro-USD (NULL: unpriced, counted in unpriced_turns).
CREATE FUNCTION app_assistant_charge(
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
		v_res assistant_reservation;
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
		RETURN QUERY SELECT * FROM assistant_month_spent(v_now_month, p_project, v_user);
	END
	$$;
REVOKE ALL ON FUNCTION app_assistant_charge(uuid, uuid, bigint, bigint, bigint, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_charge(uuid, uuid, bigint, bigint, bigint, bigint, bigint) TO water_app;

-- The 4-argument form (264), kept for a backend released before this
-- migration: the same charge with no cache tokens and no cost (unpriced).
CREATE OR REPLACE FUNCTION app_assistant_charge(p_project uuid, p_reservation uuid, p_input bigint, p_output bigint)
	RETURNS TABLE (project_used bigint, user_used bigint, total_used bigint)
	LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT * FROM app_assistant_charge(p_project, p_reservation, p_input, p_output, 0::bigint, 0::bigint, NULL::bigint)
	$$;
REVOKE ALL ON FUNCTION app_assistant_charge(uuid, uuid, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_charge(uuid, uuid, bigint, bigint) TO water_app;
