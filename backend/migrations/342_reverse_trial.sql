-- 342_reverse_trial — the 14-day Pro reverse trial, once per canonical email,
-- and its own assistant caps (issue #641 "Free tier and abuse" → "Reverse
-- trial: yes, 14 days"; docs/billing.md § Pro: the reverse trial).
--
-- Built but off: the backend asks for a trial only when REVERSE_TRIAL=true and
-- BILLING_ENFORCED=true (billing/reverseTrial.ts reverseTrialOn), at the moment
-- an address is first verified (auth/email-routes.ts markVerified). With either
-- off nothing here is ever called and no claim is recorded, so turning it on
-- later still gives each person their one trial.
--
--   1. reverse_trial_claim: one row per canonical email that has had its
--      trial, ever. It holds a SHA-256 of the canonical address (lower-cased,
--      `+tag` dropped, Gmail's dots dropped, googlemail.com as gmail.com;
--      billing/metrics.ts canonicalEmail) and when, never the address and no
--      link to the account, so it survives the account's deletion (the point:
--      deleting and signing up again gives no second trial) and on its own
--      names nobody. Owner only: RLS on, no policy, no privilege to water_app;
--      only app_reverse_trial_start writes it, and nothing reads it but that
--      function. docs/security.md § Personal information says what it is.
--   2. app_reverse_trial_start(email_hash): the caller's own personal account
--      gets Pro as 'trialing' for plan.trial_days (14) days: provider 'manual'
--      (no payment provider is involved), period_end = trial_end = the end,
--      cancel_at_period_end true (so the renewal notice, 329, never picks it
--      up), logged in billing_grant_log (330) as a 'grant' by 'reverse trial'.
--      It answers, in this order:
--        'unverified' the caller's address isn't verified (email_verified_at, 004);
--        'live'       the account already has a live subscription (a staff
--                     grant, a paid plan): nothing claimed, so the trial stays
--                     available for later;
--        'claimed'    this canonical email had its trial already;
--        'started'    the trial began.
--      The account row is locked first, so two verifications at once grant at
--      most one; the claim's primary key is the backstop across accounts.
--      The hash comes from the backend (auth/email-routes.ts reads the caller's
--      own address and hashes its canonical form); the function checks only its
--      shape.
--   3. app_reverse_trial_expire(): the worker's tick (jobs/runner.ts), from the
--      worker's context only, moves every reverse trial whose trial_end has
--      passed to 'expired' and logs it. The account is then Free (no live
--      subscription, 323); nothing is deleted. Like a staff grant, a trial can
--      outlive its end by at most one tick (5 minutes in production).
--   4. A reverse trial is a subscription with provider 'manual' and status
--      'trialing': staff grants (330) and invoice grants (335) are 'active',
--      Stripe's trials are provider 'stripe', so nothing else writes that pair.
--      subscription_reverse_trial(sub) names the test.
--   5. app_assistant_begin (12 arguments), from its latest definition (337):
--      during a reverse trial the assistant has the trial's own caps, $2 over
--      the whole trial and $1 a SAST day (assistant_trial_caps, mirrored by
--      assistant/dollarCaps.ts TRIAL_CAPS; a DB test pins the two), beside
--      Pro's month. The trial still draws on the Free pool (336's
--      assistant_pool_account already counts a 'trialing' account in it; 337's
--      begin put it in v_in_pool), so the pool's month and paced day bind too.
--      Two new outcomes, refused only with billing enforced, as every dollar cap:
--        'trial'     the trial's $2 is spent: wait to the trial's end (then the
--                    account is Free, with Free's own day);
--        'trial_day' today's $1 is spent: wait to the next 00:00 SAST, or the
--                    trial's end if sooner.
--      The trial's spend is every day row of the account from the trial's
--      first SAST day on (assistant_day_usage, 336: dollars land on the day the
--      turn began), plus the account's open reservations; its day is the
--      person's day on the account (assistant_dollars_spent member_day, a
--      personal account having one person). A day row from before the trial
--      began on its first day is counted too: more, never less.
--
-- Started from the latest definitions: app_assistant_begin 12-argument (337).
-- subscription (323), billing_grant_log (330) and billing_account_ensure (323)
-- are used as they are.

-- ---------------------------------------------------------------------------
-- 1. reverse_trial_claim
-- ---------------------------------------------------------------------------
CREATE TABLE reverse_trial_claim (
	-- SHA-256 (hex) of the canonical address; never the address.
	email_hash text PRIMARY KEY CHECK (email_hash ~ '^[0-9a-f]{64}$'),
	claimed_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE reverse_trial_claim IS
	'One row per canonical email that has had the Pro reverse trial, ever (342, issue #641 "Once per canonical email"): a SHA-256 of the canonical address and when, no address and no account, so it outlives the account. Owner only; written by app_reverse_trial_start alone.';
ALTER TABLE reverse_trial_claim ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reverse_trial_claim FROM PUBLIC, water_app;

-- The expiry tick's scan: live reverse trials by their end.
CREATE INDEX subscription_reverse_trial_end_idx ON subscription (trial_end) WHERE provider = 'manual' AND status = 'trialing';

-- ---------------------------------------------------------------------------
-- 4. What a reverse trial is
-- ---------------------------------------------------------------------------
CREATE FUNCTION subscription_reverse_trial(p_provider text, p_status text) RETURNS boolean
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$ SELECT p_provider = 'manual' AND p_status = 'trialing' $$;
REVOKE ALL ON FUNCTION subscription_reverse_trial(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION subscription_reverse_trial(text, text) TO water_app;

-- The trial's assistant caps in micro-USD: $2 in all, $1 a SAST day (#641
-- "AI during the trial"). assistant/dollarCaps.ts TRIAL_CAPS is the same pair.
CREATE FUNCTION assistant_trial_caps(OUT total_usd_micros bigint, OUT day_usd_micros bigint)
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$ SELECT 2000000::bigint, 1000000::bigint $$;
REVOKE ALL ON FUNCTION assistant_trial_caps() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant_trial_caps() TO water_app;

-- ---------------------------------------------------------------------------
-- 2. app_reverse_trial_start
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_reverse_trial_start(p_email_hash text) RETURNS text
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_verified boolean;
		v_account uuid;
		v_days integer;
		v_end timestamptz;
		v_id uuid;
	BEGIN
		IF v_user IS NULL THEN
			RAISE EXCEPTION 'app_reverse_trial_start: not allowed' USING ERRCODE = '42501';
		END IF;
		IF p_email_hash IS NULL OR p_email_hash !~ '^[0-9a-f]{64}$' THEN
			RAISE EXCEPTION 'app_reverse_trial_start: a SHA-256 hex digest' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		SELECT email_verified_at IS NOT NULL INTO v_verified FROM app_user WHERE id = v_user;
		IF NOT coalesce(v_verified, false) THEN
			RETURN 'unverified';
		END IF;
		SELECT trial_days INTO v_days FROM plan WHERE code = 'pro';
		IF coalesce(v_days, 0) < 1 THEN
			RAISE EXCEPTION 'app_reverse_trial_start: plan pro has no trial_days' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		v_account := billing_account_ensure('user', v_user);
		-- One start at a time per account, against a concurrent grant or webhook (the one-live index is the backstop).
		PERFORM 1 FROM billing_account WHERE id = v_account FOR UPDATE;
		IF EXISTS (SELECT 1 FROM subscription WHERE billing_account_id = v_account AND status IN ('trialing', 'active', 'past_due')) THEN
			RETURN 'live';
		END IF;
		INSERT INTO reverse_trial_claim (email_hash) VALUES (p_email_hash) ON CONFLICT (email_hash) DO NOTHING;
		IF NOT FOUND THEN
			RETURN 'claimed';
		END IF;
		v_end := now() + make_interval(days => v_days);
		INSERT INTO subscription (billing_account_id, plan_code, status, period_start, period_end, trial_end, cancel_at_period_end, provider)
		VALUES (v_account, 'pro', 'trialing', now(), v_end, v_end, true, 'manual')
		RETURNING id INTO v_id;
		INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
		VALUES (v_account, v_id, 'grant', 'pro', v_end, 'the ' || v_days || '-day Pro trial for a newly verified person', 'reverse trial');
		RETURN 'started';
	END
	$$;
REVOKE ALL ON FUNCTION app_reverse_trial_start(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_reverse_trial_start(text) TO water_app;

-- ---------------------------------------------------------------------------
-- 3. app_reverse_trial_expire: the worker's tick
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_reverse_trial_expire() RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker expires reverse trials' USING ERRCODE = 'insufficient_privilege';
		END IF;
		WITH lapsed AS (
			UPDATE subscription SET status = 'expired'
			WHERE provider = 'manual' AND status = 'trialing' AND trial_end <= now()
			RETURNING id, billing_account_id, plan_code, trial_end
		)
		INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
		SELECT billing_account_id, id, 'expire', plan_code, trial_end, 'the trial reached its end', 'expiry' FROM lapsed;
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;
REVOKE ALL ON FUNCTION app_reverse_trial_expire() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_reverse_trial_expire() TO water_app;

-- ---------------------------------------------------------------------------
-- 5. app_assistant_begin: 337's, with the reverse trial's caps
-- ---------------------------------------------------------------------------
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
