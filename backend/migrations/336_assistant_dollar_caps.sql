-- 336_assistant_dollar_caps — the assistant's caps in dollars, and the paced
-- Free pool, reserved before the turn as 264 reserves tokens (issue #641
-- "Free AI allowance" and "Free tier and abuse", accepted 2026-10-29;
-- docs/billing.md § Assistant dollar caps). Built but OFF: nothing here
-- refuses a turn unless app.billing_enforced is 'on' (backend/src/db/tx.ts,
-- from BILLING_ENFORCED). Off, a turn begins exactly as 264's does (the token
-- caps, the same budget); the dollars are still reserved and recorded (shadow
-- mode), so the report can measure what enforcement would do.
--
-- The caps, each against the project's billing account (project.billing_account_id):
--   - month:  the plan's dollar allowance (plan.limits, 323):
--             assistant_usd_micros_per_month (Free $1, Pro $15), or
--             assistant_usd_micros_per_seat_month × seats (Team, $15 each; the
--             live subscription's seats, never fewer than seats_included,
--             as app_account_plan) — the account's whole month, pooled;
--   - member: on a per-seat plan (Team), one person's share of that pooled
--             month, billing_account.assistant_member_max_pct (default 50; no
--             UI raises it yet, docs/followups.md);
--   - day:    on Free, one person's dollars a UTC day (p_free_usd_micros_per_day,
--             ASSISTANT_FREE_USD_PER_DAY, $0.30) or messages a UTC day
--             (p_free_messages_per_day, 20), whichever comes first;
--   - pool:   Free and trialing accounts together, at most
--             p_pool_usd_micros_per_month a UTC month (ASSISTANT_FREE_POOL_USD_PER_MONTH,
--             $30), and on any UTC day at most
--             (pool left at the day's start ÷ days left, today included) × 2
--             (assistant_pool_day_allowance).
-- Spend is the month's (or day's) recorded cost plus every reservation's
-- dollars, so concurrent turns can't overshoot: begins are serialised by
-- 264's deployment lock, and the sums are one statement each
-- (assistant_dollars_spent), as 264's tokens are.
--
-- A turn's dollar reservation is its token budget × p_usd_micros_per_token,
-- the model's dearest price per weighted token (pricing.ts
-- usdMicrosPerWeightedToken: the greatest of input, cache write and output ÷ 5),
-- rounded up: no turn within its token budget can cost more. Enforced, the
-- token budget is also cut to what each dollar cap has left ÷ that price, and
-- a cap with less than the turn's floor (p_min_turn_tokens × price) left
-- refuses. A model with no price (NULL) reserves no dollars and is refused
-- only by a cap already spent (its turns are recorded as unpriced, 324).
-- Outcomes, after 264's (rate, total_budget, user_budget, budget), checked
-- person first so a refusal names the person's own cap when it binds:
--   'day'    the person's Free day is spent (dollars or messages): wait to UTC midnight;
--   'month'  the account's month is spent: wait to the UTC month's end;
--   'member' the person's share of a Team's month is spent: same wait;
--   'pool'   the Free pool's month, or today's paced share, is spent: wait
--            to UTC midnight (or the month's end, when the month's pool is).
-- Every boundary is UTC, as assistant_usage's month (262). #641 states 00:00
-- SAST for the Free day; that move waits for the operator (docs/followups.md).
--
-- Tables: assistant_day_usage (new) counts each person's day per account
-- (messages at begin, dollars at charge); assistant_reservation gains the
-- dollars it holds and the UTC day it began. assistant_usage is unchanged
-- (cost_usd_micros, 324); an expired reservation with dollars now adds them to
-- cost_usd_micros (an upper bound, never short) instead of counting an
-- unpriced turn. Started from the latest definitions: app_assistant_begin
-- (264), app_assistant_charge 7-argument (324), assistant_settle_expired (324),
-- app_purge_assistant (264).

ALTER TABLE assistant_reservation
	ADD COLUMN reserved_usd_micros bigint CHECK (reserved_usd_micros IS NULL OR reserved_usd_micros >= 0),
	ADD COLUMN day date;
COMMENT ON COLUMN assistant_reservation.reserved_usd_micros IS
	'The dollars (micro-USD) the turn''s budget can cost at most, at its model''s dearest price per weighted token; NULL for a model with no price (336).';
COMMENT ON COLUMN assistant_reservation.day IS 'The UTC day the turn began: the day its cost counts against (336). NULL on a pre-336 reservation.';
CREATE INDEX assistant_reservation_day_idx ON assistant_reservation (day);

ALTER TABLE billing_account
	ADD COLUMN assistant_member_max_pct smallint NOT NULL DEFAULT 50 CHECK (assistant_member_max_pct BETWEEN 1 AND 100);
COMMENT ON COLUMN billing_account.assistant_member_max_pct IS
	'On a per-seat plan (Team), the share of the account''s monthly assistant dollars one person may use (336; #641: 50%, a team admin may raise it; no route sets it yet).';

CREATE TABLE assistant_day_usage (
	billing_account_id uuid NOT NULL REFERENCES billing_account (id) ON DELETE CASCADE,
	user_id            uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
	-- A UTC day.
	day                date NOT NULL,
	messages           integer NOT NULL DEFAULT 0 CHECK (messages >= 0),
	cost_usd_micros    bigint NOT NULL DEFAULT 0 CHECK (cost_usd_micros >= 0),
	updated_at         timestamptz NOT NULL DEFAULT now(),
	-- Covers the account key.
	PRIMARY KEY (billing_account_id, day, user_id)
);
-- Covers the user key.
CREATE INDEX assistant_day_usage_user_idx ON assistant_day_usage (user_id);
-- The day's pool sums, and the purge.
CREATE INDEX assistant_day_usage_day_idx ON assistant_day_usage (day);
COMMENT ON TABLE assistant_day_usage IS
	'Each person''s assistant use per billing account and UTC day: messages counted at begin, dollars at charge (336, issue #641). Written only by app_assistant_begin, app_assistant_charge and the expiry sweep; a person reads their own rows.';

ALTER TABLE assistant_day_usage ENABLE ROW LEVEL SECURITY;
-- As assistant_usage (262): a person reads their own rows; nobody writes but the definer functions.
CREATE POLICY assistant_day_usage_own ON assistant_day_usage FOR SELECT TO water_app
	USING (user_id = app_current_user_id());
REVOKE ALL ON assistant_day_usage FROM water_app;
GRANT SELECT ON assistant_day_usage TO water_app;

-- The pool's share for a UTC day: (pool left at the day's start ÷ days left in
-- the month, the day included) × 2, never below 0. p_spent_before_today is the
-- month's pool spend before the day. backend/src/assistant/dollarCaps.ts
-- poolDayAllowance is the same sum (a DB test pins the two together).
CREATE FUNCTION assistant_pool_day_allowance(p_pool bigint, p_spent_before_today bigint, p_day date) RETURNS bigint
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
		SELECT greatest(0, floor(
			greatest(0, p_pool - p_spent_before_today)::numeric
			/ ((date_trunc('month', p_day) + interval '1 month')::date - p_day)
			* 2
		))::bigint
	$$;
REVOKE ALL ON FUNCTION assistant_pool_day_allowance(bigint, bigint, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant_pool_day_allowance(bigint, bigint, date) TO water_app;

-- Whether an account draws on the Free pool: no live subscription (Free), a
-- live one on the free plan, or a trial. Internal (runs as its caller).
CREATE FUNCTION assistant_pool_account(p_account uuid) RETURNS boolean
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT NOT EXISTS (
			SELECT 1 FROM subscription s
			WHERE s.billing_account_id = p_account AND s.status IN ('trialing', 'active', 'past_due')
				AND s.status <> 'trialing' AND s.plan_code <> 'free'
		)
	$$;
REVOKE ALL ON FUNCTION assistant_pool_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_pool_account(uuid) FROM water_app;

-- The dollars (micro-USD) spent and reserved, in one statement so a charge
-- moving dollars from a reservation to the usage rows is seen once:
--   account_month: the account's projects this UTC month;
--   member_month:  the person's part of that;
--   member_day:    the person's on this account today (UTC);
--   member_day_messages: their messages on it today;
--   pool_month, pool_today: every pool account's (assistant_pool_account).
-- Internal: only the definer functions below can read the tables through it.
CREATE FUNCTION assistant_dollars_spent(p_month date, p_day date, p_account uuid, p_user uuid)
	RETURNS TABLE (account_month bigint, member_month bigint, member_day bigint, member_day_messages bigint, pool_month bigint, pool_today bigint)
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		WITH spend AS (
			-- The month's recorded cost.
			SELECT p.billing_account_id AS account, u.user_id, u.cost_usd_micros AS usd, false AS today, 0::bigint AS msgs
				FROM assistant_usage u JOIN project p ON p.id = u.project_id
				WHERE u.month = p_month AND u.cost_usd_micros > 0
			UNION ALL
			-- Today's recorded cost and messages (a day row is in the month's cost too: only `today` reads it).
			SELECT d.billing_account_id, d.user_id, d.cost_usd_micros, true, d.messages
				FROM assistant_day_usage d WHERE d.day = p_day
			UNION ALL
			-- Every reservation's dollars: in the month, and today when it began today.
			SELECT p.billing_account_id, r.user_id, coalesce(r.reserved_usd_micros, 0), false, 0
				FROM assistant_reservation r JOIN project p ON p.id = r.project_id
				WHERE r.month = p_month
			UNION ALL
			SELECT p.billing_account_id, r.user_id, coalesce(r.reserved_usd_micros, 0), true, 0
				FROM assistant_reservation r JOIN project p ON p.id = r.project_id
				WHERE r.day = p_day
		), pool AS (
			SELECT DISTINCT account FROM spend WHERE account IS NOT NULL AND assistant_pool_account(account)
		)
		SELECT
			coalesce(sum(s.usd) FILTER (WHERE NOT s.today AND s.account = p_account), 0)::bigint,
			coalesce(sum(s.usd) FILTER (WHERE NOT s.today AND s.account = p_account AND s.user_id = p_user), 0)::bigint,
			coalesce(sum(s.usd) FILTER (WHERE s.today AND s.account = p_account AND s.user_id = p_user), 0)::bigint,
			coalesce(sum(s.msgs) FILTER (WHERE s.today AND s.account = p_account AND s.user_id = p_user), 0)::bigint,
			coalesce(sum(s.usd) FILTER (WHERE NOT s.today AND s.account IN (SELECT account FROM pool)), 0)::bigint,
			coalesce(sum(s.usd) FILTER (WHERE s.today AND s.account IN (SELECT account FROM pool)), 0)::bigint
		FROM spend s
	$$;
REVOKE ALL ON FUNCTION assistant_dollars_spent(date, date, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_dollars_spent(date, date, uuid, uuid) FROM water_app;

-- As 324, and an expired reservation's dollars added to the cost (and to its
-- day's row), so the dollar caps count it in full; only one with no dollars
-- (an unpriced model, or begun before 336) is counted as an unpriced turn.
CREATE OR REPLACE FUNCTION assistant_settle_expired() RETURNS integer
	LANGUAGE plpgsql VOLATILE SET search_path = public
	AS $$
	DECLARE
		v_n integer;
	BEGIN
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

-- 264's begin, and the dollar caps after its token caps. New arguments:
--   p_usd_micros_per_token: the model's dearest micro-USD per weighted token
--     (NULL: no price; 0: a free local model);
--   p_free_usd_micros_per_day, p_free_messages_per_day: Free's day (NULL: none);
--   p_pool_usd_micros_per_month: the Free pool (NULL: none).
-- New columns: reserved_usd_micros (the reservation's dollars), and
-- pool_used_usd_micros / pool_usd_micros (the pool's month spent and reserved
-- before this turn, and its size; NULL when the account isn't in the pool),
-- which the backend logs for the pool's 50% and 80% alarms.
CREATE FUNCTION app_assistant_begin(
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
		v_day date := (now() AT TIME ZONE 'UTC')::date;
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
		v_day_wait := greatest(1, ceil(extract(epoch FROM ((v_day + 1)::timestamp AT TIME ZONE 'UTC') - now())))::integer;
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
					assistant_pool_day_allowance(p_pool_usd_micros_per_month, v_spent.pool_month - v_spent.pool_today, v_day) - v_spent.pool_today);
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

-- 264's 8-argument form, kept for a backend released before this migration
-- (expand; it goes once no release calls it): the new begin with no price and
-- no Free day or pool, so only the plan's month (and a Team member's share)
-- can refuse, and only when enforced.
CREATE OR REPLACE FUNCTION app_assistant_begin(
	p_project uuid,
	p_tokens_per_month bigint,
	p_messages_per_hour integer,
	p_tokens_per_user_month bigint,
	p_tokens_total_per_month bigint,
	p_max_turn_tokens bigint,
	p_min_turn_tokens bigint,
	p_reservation_seconds integer
)
	RETURNS TABLE (outcome text, wait_seconds integer, project_used bigint, user_used bigint, total_used bigint, reservation_id uuid, budget bigint)
	LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT b.outcome, b.wait_seconds, b.project_used, b.user_used, b.total_used, b.reservation_id, b.budget
		FROM app_assistant_begin(p_project, p_tokens_per_month, p_messages_per_hour, p_tokens_per_user_month, p_tokens_total_per_month,
			p_max_turn_tokens, p_min_turn_tokens, p_reservation_seconds, NULL::numeric, NULL::bigint, NULL::integer, NULL::bigint) b
	$$;
REVOKE ALL ON FUNCTION app_assistant_begin(uuid, bigint, integer, bigint, bigint, bigint, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_begin(uuid, bigint, integer, bigint, bigint, bigint, bigint, integer) TO water_app;

-- As 324's 7-argument charge, and the turn's cost added to its person's day
-- row on the project's account (the reservation's day; today with none).
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
		v_day date := (now() AT TIME ZONE 'UTC')::date;
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

-- As 264, and the day rows older than the months kept go too.
CREATE OR REPLACE FUNCTION app_purge_assistant(p_months integer) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_rate integer;
		v_usage integer;
		v_day integer;
		v_reserved integer;
		v_cutoff date;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker purges the assistant counters' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_months IS NULL OR p_months < 2 THEN
			RAISE EXCEPTION 'keep at least this month and the one before' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		PERFORM pg_advisory_xact_lock(hashtext('assistant_usage:all'));
		v_reserved := assistant_settle_expired();
		DELETE FROM assistant_rate WHERE window_start <= now() - interval '1 hour';
		GET DIAGNOSTICS v_rate = ROW_COUNT;
		v_cutoff := (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => p_months - 1))::date;
		DELETE FROM assistant_usage WHERE month < v_cutoff;
		GET DIAGNOSTICS v_usage = ROW_COUNT;
		DELETE FROM assistant_day_usage WHERE day < v_cutoff;
		GET DIAGNOSTICS v_day = ROW_COUNT;
		RETURN v_rate + v_usage + v_day + v_reserved;
	END
	$$;
