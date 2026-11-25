-- 364_assistant_lock_order — one lock order for the assistant's metering, so a
-- begin, a charge and an account's deletion never deadlock (docs/billing.md §
-- The counters, Lock order). Results are unchanged: only the order in which
-- locks are taken moves.
--
-- 361's triggers take the deployment-wide counter lock (assistant_counter_lock)
-- when a counted row changes, that is after the row is written and locked. Two
-- deadlocks followed, both reproduced in src/assistant/lockOrder.db.test.ts:
--   1. A begin whose settle charged an expired reservation held the counter
--      lock, then wrote its own usage row (messages + 1), while a charge of the
--      same person's turn in flight had written that row and waited in its
--      trigger for the counter lock.
--   2. An account's deletion locked its billing_account row and waited for the
--      counter lock in 361's BEFORE DELETE trigger, while a charge holding the
--      counter lock inserted the account's first month counter row (or its pool
--      membership) and waited on the foreign key's share lock on that same row.
--
-- The order now, for every transaction that can take the counter lock:
--   (a) the parent rows its writes reference, in the order a deletion locks
--       them: app_user, then project, then billing_account, FOR KEY SHARE (or
--       exclusively, for a deletion);
--   (b) the counter lock;
--   (c) the counted rows (reservation, usage, day, counters).
-- So the charge locks its person, its project and the project's account FOR
-- KEY SHARE, then takes the counter lock (when it has a cost to count), and
-- only then its reservation and rows; the settle (in a begin and in the purge)
-- does the same for the parents of the reservations expired in its lock
-- queries' snapshot, before its DELETE; the begin locks its own parents before
-- the settle. The person comes first because a person's deletion locks the
-- app_user row (the DELETE itself) before its trigger locks the billing
-- account: a transaction holding the account and then asking for the person
-- would deadlock with it. A team's deletion locks the team row (which nothing
-- here locks), then its account, and sets its projects' team to NULL (no key
-- change, so no conflict with KEY SHARE). A deletion locks the rows
-- it deletes before any trigger takes the counter lock: app_user's and team's
-- new BEFORE DELETE triggers lock their billing account first, so no cascade
-- order (they fire in trigger name order, that is oid order) can take the
-- counter lock before the account row. Billing writers already lock the account
-- FOR UPDATE before a subscription change takes the counter lock.
--
-- Cost: a charge with a cost now holds the counter lock from its start, not
-- from its usage row's write (both short); a charge with no cost or no account
-- never takes it. A begin takes it only when it settles something, as before.
--
-- Started from the latest definitions: assistant_settle_expired (336),
-- app_assistant_begin's 12-argument form (342) and app_assistant_charge's
-- 7-argument form (337), each changed only by the locks marked 364. The older
-- forms (begin's 8 arguments, 336; charge's 4, 324) call these and are
-- unchanged.

-- 336's settle, with 364's locks first.
CREATE OR REPLACE FUNCTION assistant_settle_expired() RETURNS integer
	LANGUAGE plpgsql VOLATILE SET search_path = public
	AS $$
	DECLARE
		v_n integer;
	BEGIN
		-- 364: something to settle writes counted rows, so the parent rows they reference first, then the counter lock.
		IF EXISTS (SELECT 1 FROM assistant_reservation WHERE expires_at <= now()) THEN
			-- People, projects, accounts: a deletion's order. The set is the one these queries see; the reservations
			-- the DELETE below finds are those or fewer (begins are serialised by 264's lock, charges only remove),
			-- unless a project moved account in between, whose new account is then not locked here.
			PERFORM 1 FROM app_user u WHERE u.id IN (SELECT r.user_id FROM assistant_reservation r WHERE r.expires_at <= now())
				ORDER BY u.id FOR KEY SHARE;
			PERFORM 1 FROM project p WHERE p.id IN (SELECT r.project_id FROM assistant_reservation r WHERE r.expires_at <= now())
				ORDER BY p.id FOR KEY SHARE;
			PERFORM 1 FROM billing_account a WHERE a.id IN (SELECT p.billing_account_id FROM assistant_reservation r JOIN project p ON p.id = r.project_id
				WHERE r.expires_at <= now()) ORDER BY a.id FOR KEY SHARE;
			PERFORM assistant_counter_lock();
		END IF;
		WITH gone AS (
			DELETE FROM assistant_reservation WHERE expires_at <= now()
			RETURNING project_id, user_id, month, day, reserved, reserved_usd_micros
		), per_row AS (
			SELECT project_id, user_id, month, sum(reserved)::bigint AS reserved,
				coalesce(sum(reserved_usd_micros), 0)::bigint AS usd,
				count(*) FILTER (WHERE reserved_usd_micros IS NULL)::integer AS unpriced,
				count(*)::integer AS n
			FROM gone GROUP BY project_id, user_id, month
		), per_day AS (
			SELECT p.billing_account_id AS account, g.user_id, g.day, sum(g.reserved_usd_micros)::bigint AS usd
			FROM gone g JOIN project p ON p.id = g.project_id
			WHERE g.day IS NOT NULL AND g.user_id IS NOT NULL AND g.reserved_usd_micros IS NOT NULL AND p.billing_account_id IS NOT NULL
			GROUP BY 1, 2, 3
		), charged AS (
			-- Runs whether or not the query below reads it (a data-modifying WITH always runs to completion).
			INSERT INTO assistant_usage (project_id, user_id, month, input_tokens, cost_usd_micros, unpriced_turns)
			SELECT project_id, user_id, month, reserved, usd, unpriced FROM per_row
			ON CONFLICT (project_id, month, user_id) DO UPDATE
				SET input_tokens = assistant_usage.input_tokens + EXCLUDED.input_tokens,
					cost_usd_micros = assistant_usage.cost_usd_micros + EXCLUDED.cost_usd_micros,
					unpriced_turns = assistant_usage.unpriced_turns + EXCLUDED.unpriced_turns,
					updated_at = now()
		), charged_day AS (
			INSERT INTO assistant_day_usage (billing_account_id, user_id, day, cost_usd_micros)
			SELECT account, user_id, day, usd FROM per_day
			ON CONFLICT (billing_account_id, day, user_id) DO UPDATE
				SET cost_usd_micros = assistant_day_usage.cost_usd_micros + EXCLUDED.cost_usd_micros, updated_at = now()
		)
		SELECT coalesce(sum(n), 0)::integer INTO v_n FROM per_row;
		RETURN v_n;
	END
	$$;
REVOKE ALL ON FUNCTION assistant_settle_expired() FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_settle_expired() FROM water_app;

-- 342's begin, with 364's locks before the settle.
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
		v_trial_wait integer;
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
		v_trial boolean := false;
		v_caps record;
		v_limit bigint;
		v_seats bigint;
		v_spent record;
		v_min_usd bigint;
		v_left_day bigint;
		v_left_month bigint;
		v_left_member bigint;
		v_left_pool bigint;
		v_left_trial bigint;
		v_left_trial_day bigint;
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
		-- 364: the parent rows this begin's own inserts reference (person, project, account), before the settle can take the counter lock.
		PERFORM 1 FROM app_user WHERE id = v_user FOR KEY SHARE;
		PERFORM 1 FROM project WHERE id = p_project FOR KEY SHARE;
		PERFORM 1 FROM billing_account WHERE id = (SELECT billing_account_id FROM project WHERE id = p_project) FOR KEY SHARE;
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
			v_trial := coalesce(subscription_reverse_trial(v_sub.provider, v_sub.status), false);
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
			IF v_trial THEN
				-- 342: the reverse trial's $2 over the trial and $1 a SAST day.
				SELECT * INTO v_caps FROM assistant_trial_caps();
				v_left_trial_day := v_caps.day_usd_micros - v_spent.member_day;
				v_left_trial := v_caps.total_usd_micros
					- coalesce((SELECT sum(d.cost_usd_micros) FROM assistant_day_usage d
						WHERE d.billing_account_id = v_account.id AND d.day >= assistant_day_of(v_sub.period_start)), 0)
					- coalesce((SELECT sum(coalesce(r.reserved_usd_micros, 0)) FROM assistant_reservation r JOIN project p ON p.id = r.project_id
						WHERE p.billing_account_id = v_account.id), 0);
				v_trial_wait := greatest(1, ceil(extract(epoch FROM v_sub.trial_end - now())))::integer;
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
				-- The trial's whole allowance before its day, so a spent trial never says "tomorrow".
				IF v_left_trial < v_min_usd THEN
					RETURN QUERY SELECT 'trial'::text, v_trial_wait, v_project, v_mine, v_total, NULL::uuid, NULL::bigint, NULL::bigint, v_pool_used, p_pool_usd_micros_per_month;
					RETURN;
				END IF;
				IF v_left_trial_day < v_min_usd THEN
					RETURN QUERY SELECT 'trial_day'::text, least(v_day_wait, v_trial_wait), v_project, v_mine, v_total, NULL::uuid, NULL::bigint, NULL::bigint, v_pool_used, p_pool_usd_micros_per_month;
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
						floor(v_left_trial / p_usd_micros_per_token)::bigint,
						floor(v_left_trial_day / p_usd_micros_per_token)::bigint,
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

-- 337's charge, with 364's locks first.
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
		RETURN QUERY SELECT * FROM assistant_month_spent(v_now_month, p_project, v_user);
	END
	$$;

REVOKE ALL ON FUNCTION app_assistant_charge(uuid, uuid, bigint, bigint, bigint, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_charge(uuid, uuid, bigint, bigint, bigint, bigint, bigint) TO water_app;


-- ---------------------------------------------------------------------------
-- Deletions: the billing account row before any cascade can take the counter lock
-- ---------------------------------------------------------------------------
CREATE FUNCTION assistant_lock_account_first() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF TG_TABLE_NAME = 'app_user' THEN
			PERFORM 1 FROM billing_account WHERE user_id = OLD.id FOR UPDATE;
		ELSE
			PERFORM 1 FROM billing_account WHERE team_id = OLD.id FOR UPDATE;
		END IF;
		RETURN OLD;
	END
	$$;
REVOKE ALL ON FUNCTION assistant_lock_account_first() FROM PUBLIC;

CREATE TRIGGER assistant_lock_account_first BEFORE DELETE ON app_user
	FOR EACH ROW EXECUTE FUNCTION assistant_lock_account_first();
CREATE TRIGGER assistant_lock_account_first BEFORE DELETE ON team
	FOR EACH ROW EXECUTE FUNCTION assistant_lock_account_first();
