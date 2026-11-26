-- 406_billing_conflict — a subscription event refused for its price is kept
-- for the operator, not only logged (issue #928 follow-up; docs/billing.md
-- § Price check, docs/security.md § Personal information).
--
-- 405 answers a live subscription event whose price isn't the plan's with a
-- 'conflict' and a warn line. Two cases then need the operator: a new
-- subscription Stripe charges but the app refused (refund it or grant the
-- plan), and a held one whose price drifted (it keeps its last accepted
-- state). A log line is too easy to miss, so:
--   1. billing_conflict: one row per refused event, keyed by account and the
--      provider's subscription ref, with the event id, the reason, the plan,
--      interval and seats it claimed, the amount and currency it carried, the
--      amount the plan table expected, and whether a subscription was held.
--      No card data, no email, no name. Owner-only: RLS on, no policy, no
--      grant to water_app (catalogue.db.test.ts OWNER_ONLY); read by
--      `pnpm dev:billing:report` on the owner connection (gatherReport.ts).
--      Cascades with its billing account (an account deletion takes it).
--   2. app_billing_apply, redefined from 405 (its latest): writes the row on a
--      price conflict, and marks every open row for a ref resolved when a later
--      event for that ref applies (a corrected price, a cancellation).
--   3. app_purge_billing_events, redefined from 327 (its latest): also deletes
--      resolved rows resolved longer ago than the billing events' retention
--      (90 days). Unresolved rows stay until resolved or the account goes:
--      each is an open action for the operator.

CREATE TABLE billing_conflict (
	id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	billing_account_id uuid NOT NULL REFERENCES billing_account (id) ON DELETE CASCADE,
	provider           text NOT NULL CHECK (provider IN ('mock', 'manual', 'stripe')),
	external_ref       text NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 255),
	event_id           text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 255),
	reason             text NOT NULL CHECK (reason IN ('unpriced', 'discount', 'currency', 'interval', 'amount')),
	plan_code          text NOT NULL,
	billing_interval   text CHECK (billing_interval IN ('month', 'year')),
	seats              integer NOT NULL,
	amount_minor       bigint,
	currency           text CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$'),
	expected_minor     bigint,
	held               boolean NOT NULL,
	created_at         timestamptz NOT NULL DEFAULT now(),
	resolved_at        timestamptz,
	UNIQUE (provider, event_id)
);
COMMENT ON TABLE billing_conflict IS
	'A subscription event refused because its price is not the plan''s (405/406, issue #928): for the operator (pnpm dev:billing:report). No card data or contact details. Owner-only. Resolved when a later event for the ref applies; resolved rows go after 90 days.';
CREATE INDEX billing_conflict_account_idx ON billing_conflict (billing_account_id);
CREATE INDEX billing_conflict_open_idx ON billing_conflict (provider, external_ref) WHERE resolved_at IS NULL;
ALTER TABLE billing_conflict ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billing_conflict FROM PUBLIC, water_app;

-- From 327's definition (its latest): resolved conflicts follow the billing events' retention.
CREATE OR REPLACE FUNCTION app_purge_billing_events(p_age interval) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_count integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker purges billing events' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- Past the providers' redelivery windows (Stripe: 3 days), so a purged event can't come back and apply again.
		IF p_age IS NULL OR p_age < interval '4 days' THEN
			RAISE EXCEPTION 'keep billing events at least 4 days, past the providers'' redelivery windows' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		DELETE FROM billing_event WHERE received_at < now() - p_age;
		GET DIAGNOSTICS v_count = ROW_COUNT;
		-- 406: a resolved conflict is history once its events are; an open one stays (the operator's action).
		DELETE FROM billing_conflict WHERE resolved_at < now() - p_age;
		RETURN v_count;
	END
	$$;

-- From 405's definition (its latest), recording a price conflict and resolving it.
CREATE OR REPLACE FUNCTION app_billing_apply(p_provider text, p_event_id text, p_type text, p_payload jsonb) RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_apply boolean := p_type IN ('subscription.created', 'subscription.updated', 'subscription.deleted');
		v_account uuid;
		v_ref text;
		v_plan text;
		v_status text;
		v_seats integer;
		v_start timestamptz;
		v_end timestamptz;
		v_trial timestamptz;
		v_cancel_at_end boolean;
		v_interval text;
		v_interval_given boolean := false;
		v_created timestamptz;
		v_sub subscription;
		v_outcome text;
		v_iso constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$';
		-- A paid B2B invoice's grant (335).
		v_grant boolean := false;
		v_grant_ok boolean := false;
		v_inv jsonb;
		v_inv_ref text;
		v_inv_total numeric;
		v_issued numeric;
		v_inv_plan plan;
		v_kind text;
		v_expected bigint;
		v_extra bigint;
		v_live subscription;
		v_new uuid;
		-- 344: a paid plan arriving during the reverse trial ends the trial.
		v_ends_trial boolean := false;
		-- 405: the subscription's price, when the payload carries one (#928).
		v_price_given boolean := false;
		v_price_total numeric;
		v_price_currency text;
		v_price_discounted boolean := false;
		v_price_ok boolean := true;
		v_sub_plan plan;
		v_sub_expected numeric;
		-- 406: why the price was refused.
		v_price_reason text;
	BEGIN
		-- A system path, like the job tick: never inside a user's or an API key's transaction.
		IF app_current_user_id() IS NOT NULL OR nullif(current_setting('app.current_api_key_id', true), '') IS NOT NULL THEN
			RAISE EXCEPTION 'app_billing_apply runs with no user' USING ERRCODE = 'insufficient_privilege';
		END IF;

		IF p_provider IS NULL OR p_provider NOT IN ('mock', 'manual', 'stripe')
		   OR p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
		   OR p_type IS NULL OR length(p_type) NOT BETWEEN 1 AND 100 THEN
			RETURN 'invalid';
		END IF;

		-- The payload, checked before anything is written (an invalid event is not recorded).
		IF v_apply THEN
			IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
			   OR jsonb_typeof(p_payload -> 'accountId') IS DISTINCT FROM 'string'
			   OR jsonb_typeof(p_payload -> 'externalRef') IS DISTINCT FROM 'string' THEN
				RETURN 'invalid';
			END IF;
			v_ref := p_payload ->> 'externalRef';
			IF length(v_ref) NOT BETWEEN 1 AND 255 OR (p_payload ->> 'accountId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
				RETURN 'invalid';
			END IF;
			v_account := (p_payload ->> 'accountId')::uuid;
			-- The provider's event time (327): absent or null from a sender that has none (mock, manual), else ISO 8601 with an offset.
			IF jsonb_typeof(p_payload -> 'eventCreated') NOT IN ('string', 'null') THEN
				RETURN 'invalid';
			END IF;
			IF (p_payload ->> 'eventCreated') !~ v_iso THEN
				RETURN 'invalid';
			END IF;
			BEGIN
				v_created := (p_payload ->> 'eventCreated')::timestamptz;
			EXCEPTION WHEN data_exception THEN
				RETURN 'invalid';
			END;
			IF p_type <> 'subscription.deleted' THEN
				IF jsonb_typeof(p_payload -> 'planCode') IS DISTINCT FROM 'string'
				   OR jsonb_typeof(p_payload -> 'status') IS DISTINCT FROM 'string'
				   OR jsonb_typeof(p_payload -> 'seats') IS DISTINCT FROM 'number'
				   OR jsonb_typeof(p_payload -> 'periodStart') IS DISTINCT FROM 'string'
				   OR jsonb_typeof(p_payload -> 'periodEnd') IS DISTINCT FROM 'string'
				   OR jsonb_typeof(p_payload -> 'trialEnd') NOT IN ('string', 'null')
				   OR jsonb_typeof(p_payload -> 'cancelAtPeriodEnd') IS DISTINCT FROM 'boolean' THEN
					RETURN 'invalid';
				END IF;
				v_plan := p_payload ->> 'planCode';
				v_status := p_payload ->> 'status';
				IF v_plan NOT IN ('free', 'pro', 'team') OR NOT EXISTS (SELECT 1 FROM plan WHERE code = v_plan)
				   OR v_status NOT IN ('trialing', 'active', 'past_due', 'canceled', 'expired') THEN
					RETURN 'invalid';
				END IF;
				-- ISO 8601 with an offset only: a cast alone takes 'yesterday', 'now' or 'infinity', and a bare time reads in the session's zone.
				IF (p_payload ->> 'periodStart') !~ v_iso OR (p_payload ->> 'periodEnd') !~ v_iso
				   OR (p_payload ->> 'trialEnd') !~ v_iso THEN
					RETURN 'invalid';
				END IF;
				BEGIN
					IF (p_payload ->> 'seats')::numeric <> trunc((p_payload ->> 'seats')::numeric)
					   OR (p_payload ->> 'seats')::numeric NOT BETWEEN 1 AND 100000 THEN
						RETURN 'invalid';
					END IF;
					v_seats := (p_payload ->> 'seats')::integer;
					v_start := (p_payload ->> 'periodStart')::timestamptz;
					v_end := (p_payload ->> 'periodEnd')::timestamptz;
					v_trial := (p_payload ->> 'trialEnd')::timestamptz;
				EXCEPTION WHEN data_exception THEN
					RETURN 'invalid';
				END;
				IF v_end < v_start THEN
					RETURN 'invalid';
				END IF;
				v_cancel_at_end := (p_payload ->> 'cancelAtPeriodEnd')::boolean;
				-- 344: a live paid plan from a payment provider (never a 'manual' event) takes over from a reverse trial.
				v_ends_trial := p_provider <> 'manual' AND v_plan IN ('pro', 'team') AND v_status IN ('trialing', 'active', 'past_due');
				-- The billing interval (332): absent from an older sender (the stored one is kept), null when the
				-- provider's isn't a plain month or year (a grant, an interval_count past 1), else month or year.
				IF p_payload ? 'interval' THEN
					IF jsonb_typeof(p_payload -> 'interval') = 'null' THEN
						v_interval := NULL;
					ELSIF jsonb_typeof(p_payload -> 'interval') = 'string' AND (p_payload ->> 'interval') IN ('month', 'year') THEN
						v_interval := p_payload ->> 'interval';
					ELSE
						RETURN 'invalid';
					END IF;
					v_interval_given := true;
				END IF;
				-- 405: the price (provider/stripe.ts priceOf): absent from an older sender (not checked); null when the
				-- provider's items carry no readable price (never accepted as a live plan); else its parts.
				IF p_payload ? 'price' THEN
					v_price_given := true;
					IF jsonb_typeof(p_payload -> 'price') = 'object' THEN
						IF jsonb_typeof(p_payload -> 'price' -> 'totalMinor') NOT IN ('number', 'null')
						   OR jsonb_typeof(p_payload -> 'price' -> 'currency') NOT IN ('string', 'null')
						   OR jsonb_typeof(p_payload -> 'price' -> 'discounted') IS DISTINCT FROM 'boolean' THEN
							RETURN 'invalid';
						END IF;
						v_price_total := (p_payload -> 'price' ->> 'totalMinor')::numeric;
						v_price_currency := p_payload -> 'price' ->> 'currency';
						v_price_discounted := (p_payload -> 'price' ->> 'discounted')::boolean;
						IF v_price_total IS NOT NULL AND (v_price_total <> trunc(v_price_total) OR v_price_total < 0 OR v_price_total > 1e12) THEN
							RETURN 'invalid';
						END IF;
					ELSIF jsonb_typeof(p_payload -> 'price') <> 'null' THEN
						RETURN 'invalid';
					END IF;
				END IF;
			END IF;
		ELSIF p_payload IS NOT NULL AND jsonb_typeof(p_payload) = 'object'
		      AND (p_payload ->> 'accountId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
			-- A record-only event names its account when it can; nothing is checked or applied.
			v_account := (p_payload ->> 'accountId')::uuid;
		END IF;

		-- 335: a paid B2B invoice from the staff tool (billing/invoice.ts) carries its grant, read from the metadata
		-- issueInvoice wrote (the normaliser's `invoice`). Checked here; a grant that doesn't check out is recorded
		-- as a conflict below (a retry wouldn't change it, and the operator reads the log), never raised.
		IF p_type = 'invoice.paid' AND v_account IS NOT NULL AND jsonb_typeof(p_payload -> 'invoice') = 'object' THEN
			v_grant := true;
			v_inv := p_payload -> 'invoice';
			IF jsonb_typeof(v_inv -> 'ref') = 'string' AND (v_inv ->> 'ref') ~ '^in_[A-Za-z0-9_]{1,250}$'
			   AND jsonb_typeof(v_inv -> 'planCode') = 'string' AND (v_inv ->> 'planCode') IN ('pro', 'team')
			   AND jsonb_typeof(v_inv -> 'seats') = 'number'
			   AND jsonb_typeof(v_inv -> 'interval') = 'string' AND (v_inv ->> 'interval') IN ('month', 'year')
			   AND jsonb_typeof(v_inv -> 'periodStart') = 'string' AND (v_inv ->> 'periodStart') ~ v_iso
			   AND jsonb_typeof(v_inv -> 'periodEnd') = 'string' AND (v_inv ->> 'periodEnd') ~ v_iso
			   AND jsonb_typeof(v_inv -> 'totalMinor') = 'number'
			   AND jsonb_typeof(v_inv -> 'currency') = 'string' AND (v_inv ->> 'currency') ~ '^[A-Za-z]{3}$' THEN
				BEGIN
					v_inv_ref := v_inv ->> 'ref';
					v_plan := v_inv ->> 'planCode';
					v_interval := v_inv ->> 'interval';
					v_inv_total := (v_inv ->> 'totalMinor')::numeric;
					-- The amount issued, when the metadata carries one (a positive whole number, else no grant).
					v_issued := CASE WHEN jsonb_typeof(v_inv -> 'issuedMinor') = 'number' THEN (v_inv ->> 'issuedMinor')::numeric END;
					IF (v_inv ->> 'seats')::numeric = trunc((v_inv ->> 'seats')::numeric) AND (v_inv ->> 'seats')::numeric BETWEEN 1 AND 100000
					   AND v_inv_total = trunc(v_inv_total) AND v_inv_total >= 0
					   AND (v_issued IS NULL OR (v_issued = trunc(v_issued) AND v_issued > 0))
					   AND (jsonb_typeof(v_inv -> 'issuedMinor') IN ('number', 'null') OR NOT v_inv ? 'issuedMinor') THEN
						v_seats := (v_inv ->> 'seats')::integer;
						v_start := (v_inv ->> 'periodStart')::timestamptz;
						v_end := (v_inv ->> 'periodEnd')::timestamptz;
						-- One interval, as invoicePeriod makes it (a day of slack; a clamped month is shorter).
						v_grant_ok := v_end > v_start
							AND v_end <= v_start + CASE v_interval WHEN 'year' THEN interval '1 year 1 day' ELSE interval '1 month 1 day' END;
					END IF;
				EXCEPTION WHEN data_exception THEN
					v_grant_ok := false;
				END;
			END IF;
		END IF;

		-- 1. De-duplicate: the first delivery of (provider, event_id) wins.
		INSERT INTO billing_event (provider, event_id, type, outcome) VALUES (p_provider, p_event_id, p_type, 'recorded')
			ON CONFLICT (provider, event_id) DO NOTHING;
		IF NOT FOUND THEN
			RETURN 'duplicate';
		END IF;

		-- Lock the account, so two events for one account apply one after the other (the one-live index stays a backstop).
		-- 344: 334's billing lock first, before the row lock: the subscription writes below fire 341's sync, which
		-- takes it, and taking it after FOR UPDATE would deadlock against a sync that holds it and writes the row.
		IF v_account IS NOT NULL THEN
			PERFORM pg_advisory_xact_lock(hashtext('billing:' || v_account::text));
			PERFORM 1 FROM billing_account WHERE id = v_account FOR UPDATE;
			IF NOT FOUND THEN
				v_account := NULL;
				v_outcome := CASE WHEN v_apply THEN 'unknown_account' ELSE 'recorded' END;
			END IF;
		END IF;

		IF v_outcome IS NULL AND v_apply THEN
			SELECT * INTO v_sub FROM subscription WHERE provider = p_provider AND external_ref = v_ref FOR UPDATE;
			-- 405 (#927): a lapsed subscription stays lapsed through further past_due updates (still owed); any other
			-- status (paid again, trialing, ended) replaces it.
			IF v_status = 'past_due' AND v_sub.status = 'lapsed' THEN
				v_status := 'lapsed';
			END IF;
			-- 405 (#928): a live status must cost what the plan table sets for this plan, interval and seats, in its
			-- currency, with no discount; or what was accepted before for a subscription held on the same plan and
			-- interval. Summed as 335's invoice check sums it.
			IF v_price_given AND p_type <> 'subscription.deleted' AND v_status IN ('trialing', 'active', 'past_due') THEN
				SELECT * INTO v_sub_plan FROM plan WHERE code = v_plan;
				v_sub_expected := CASE v_interval WHEN 'year' THEN v_sub_plan.price_annual_minor WHEN 'month' THEN v_sub_plan.price_monthly_minor END
					+ CASE WHEN v_seats > coalesce((v_sub_plan.limits ->> 'seats_included')::integer, 1)
					       THEN (v_seats - coalesce((v_sub_plan.limits ->> 'seats_included')::integer, 1))
					            * CASE v_interval WHEN 'year' THEN (v_sub_plan.features ->> 'extra_seat_annual_minor')::bigint
					                              ELSE (v_sub_plan.features ->> 'extra_seat_monthly_minor')::bigint END
					       ELSE 0 END;
				v_price_reason := CASE
					WHEN v_price_total IS NULL THEN 'unpriced'
					WHEN v_price_discounted THEN 'discount'
					WHEN v_interval IS NULL OR v_interval NOT IN ('month', 'year') THEN 'interval'
					WHEN lower(v_price_currency) IS DISTINCT FROM lower(v_sub_plan.currency) THEN 'currency'
					ELSE 'amount' END;
				v_price_ok := v_price_total IS NOT NULL AND NOT v_price_discounted AND v_interval IN ('month', 'year')
					AND lower(v_price_currency) IS NOT DISTINCT FROM lower(v_sub_plan.currency)
					AND (v_price_total = v_sub_expected
					     OR (v_sub.id IS NOT NULL AND v_sub.plan_code = v_plan AND v_sub.billing_interval IS NOT DISTINCT FROM v_interval
					         AND v_sub.price_minor = v_price_total));
			END IF;
			IF v_sub.id IS NOT NULL AND v_sub.billing_account_id <> v_account THEN
				v_outcome := 'conflict';
			ELSIF p_type = 'subscription.deleted' THEN
				IF v_sub.id IS NULL OR v_sub.status IN ('canceled', 'expired') THEN
					v_outcome := 'recorded';
				ELSE
					-- Never stale: a delete is the provider's last word on a subscription, whatever its time.
					UPDATE subscription SET status = 'canceled', cancel_at_period_end = false,
					                        last_event_at = greatest(last_event_at, v_created)
						WHERE id = v_sub.id;
					v_outcome := 'applied';
				END IF;
			ELSIF v_created IS NOT NULL AND v_sub.last_event_at IS NOT NULL AND v_created < v_sub.last_event_at THEN
				-- Older than the event already applied (Stripe doesn't deliver in order): skipped. An equal time applies,
				-- in arrival order, since Stripe's created is whole seconds and two real changes can share one.
				v_outcome := 'stale';
			ELSIF v_sub.status IN ('canceled', 'expired') AND v_status IN ('trialing', 'active', 'past_due') THEN
				-- An ended subscription stays ended (a late or replayed update after its delete).
				v_outcome := 'conflict';
			ELSIF v_sub.id IS NULL AND v_status IN ('trialing', 'active', 'past_due') AND EXISTS (
				SELECT 1 FROM billing_event WHERE provider = p_provider AND external_ref = v_ref AND type = 'subscription.deleted'
			) THEN
				-- 399: the provider already deleted this subscription (its delete arrived first, for a ref not yet held):
				-- a late created or update never makes it live, as an ended subscription stays ended above.
				v_outcome := 'conflict';
			ELSIF NOT v_price_ok THEN
				-- 405: not the plan's price (a dashboard price, a coupon): never applied as the plan; the operator reads it.
				v_outcome := 'conflict';
				-- 406: kept for the operator's report (a charged-but-refused subscription, or a held one that drifted).
				INSERT INTO billing_conflict (billing_account_id, provider, external_ref, event_id, reason, plan_code, billing_interval,
				                              seats, amount_minor, currency, expected_minor, held)
				VALUES (v_account, p_provider, v_ref, p_event_id, v_price_reason, v_plan,
				        CASE WHEN v_interval IN ('month', 'year') THEN v_interval END, v_seats, v_price_total,
				        CASE WHEN lower(v_price_currency) ~ '^[a-z]{3}$' THEN lower(v_price_currency) END, v_sub_expected, v_sub.id IS NOT NULL);
			ELSIF v_status IN ('trialing', 'active', 'past_due') AND EXISTS (
				SELECT 1 FROM subscription
				WHERE billing_account_id = v_account AND status IN ('trialing', 'active', 'past_due')
				  AND id IS DISTINCT FROM v_sub.id
				  -- 344: a reverse trial gives way to a paid plan (ended below); any other live plan is a conflict.
				  AND NOT (v_ends_trial AND subscription_reverse_trial(provider, status))
			) THEN
				v_outcome := 'conflict';
			ELSE
				IF v_ends_trial THEN
					-- 344: end the reverse trial in this transaction, before the paid row is written, so the one-live
					-- index holds and the account goes from the trial straight to the paid plan. Expired, as 342's tick
					-- ends one, with its end moved to now (never before it began), and logged.
					WITH ended AS (
						UPDATE subscription
						SET status = 'expired',
						    period_end = least(period_end, greatest(period_start, now())),
						    trial_end = least(trial_end, greatest(period_start, now()))
						WHERE billing_account_id = v_account AND provider = 'manual' AND status = 'trialing'
						RETURNING id, plan_code, period_end
					)
					INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
					SELECT v_account, id, 'expire', plan_code, period_end,
					       'the trial ended when the paid ' || initcap(v_plan) || ' plan began', 'checkout'
					FROM ended;
				END IF;
				IF v_sub.id IS NULL THEN
					INSERT INTO subscription (billing_account_id, plan_code, status, seats, period_start, period_end, trial_end,
					                          cancel_at_period_end, provider, external_ref, last_event_at, billing_interval,
					                          past_due_since, price_minor)
						VALUES (v_account, v_plan, v_status, v_seats, v_start, v_end, v_trial, v_cancel_at_end, p_provider, v_ref, v_created, v_interval,
						        CASE WHEN v_status = 'past_due' THEN coalesce(v_created, now()) END,
						        CASE WHEN v_price_given THEN v_price_total END);
				ELSE
					UPDATE subscription SET plan_code = v_plan, status = v_status, seats = v_seats, period_start = v_start,
					                        period_end = v_end, trial_end = v_trial, cancel_at_period_end = v_cancel_at_end,
					                        last_event_at = greatest(last_event_at, v_created),
					                        billing_interval = CASE WHEN v_interval_given THEN v_interval ELSE billing_interval END,
					                        -- 405: the overdue clock starts once and runs while past_due or lapsed.
					                        past_due_since = CASE WHEN v_status IN ('past_due', 'lapsed') THEN coalesce(past_due_since, v_created, now()) END,
					                        price_minor = CASE WHEN v_price_given AND v_price_total IS NOT NULL THEN v_price_total ELSE price_minor END
						WHERE id = v_sub.id;
				END IF;
				v_outcome := 'applied';
			END IF;
		END IF;

		-- 335: grant a paid B2B invoice's plan for its period, as a staff grant is written (330: provider 'manual',
		-- cancel_at_period_end, so the tick expires it and the renewal notice skips it), keyed by the invoice id.
		IF v_outcome IS NULL AND v_grant THEN
			SELECT * INTO v_live FROM subscription WHERE provider = 'manual' AND external_ref = v_inv_ref;
			IF NOT v_grant_ok THEN
				v_outcome := 'conflict';
			ELSIF v_live.id IS NOT NULL THEN
				-- This invoice already granted its plan (the same payment under another event id): nothing more.
				v_outcome := CASE WHEN v_live.billing_account_id = v_account THEN 'recorded' ELSE 'conflict' END;
			ELSE
				SELECT kind INTO v_kind FROM billing_account WHERE id = v_account;
				SELECT * INTO v_inv_plan FROM plan WHERE code = v_plan AND active;
				-- The invoice's total must cover the amount issued, or, without one, the price the plan table sets for
				-- these seats and this interval (an invoice cut in the dashboard grants nothing; a price change after
				-- issue doesn't refuse a paid invoice). The grant itself never reads an amount.
				v_extra := CASE v_interval WHEN 'year' THEN (v_inv_plan.features ->> 'extra_seat_annual_minor')::bigint
				                           ELSE (v_inv_plan.features ->> 'extra_seat_monthly_minor')::bigint END;
				v_expected := CASE v_interval WHEN 'year' THEN v_inv_plan.price_annual_minor ELSE v_inv_plan.price_monthly_minor END
					+ CASE WHEN v_seats > coalesce((v_inv_plan.limits ->> 'seats_included')::integer, 1)
					       THEN (v_seats - coalesce((v_inv_plan.limits ->> 'seats_included')::integer, 1)) * v_extra ELSE 0 END;
				IF v_inv_plan.code IS NULL
				   OR v_plan <> (CASE v_kind WHEN 'team' THEN 'team' ELSE 'pro' END)
				   OR lower(v_inv ->> 'currency') <> lower(v_inv_plan.currency)
				   OR coalesce(v_issued, v_expected) IS NULL OR v_inv_total < coalesce(v_issued, v_expected)
				   OR v_end <= now() THEN
					v_outcome := 'conflict';
				ELSE
					-- A lapsed grant the tick hasn't reached yet (as 330's grant does).
					WITH lapsed AS (
						UPDATE subscription SET status = 'expired'
						WHERE billing_account_id = v_account AND provider = 'manual' AND status = 'active' AND period_end <= now()
						RETURNING id, plan_code, period_end
					)
					INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
					SELECT v_account, id, 'expire', plan_code, period_end, 'the grant reached its end', 'expiry' FROM lapsed;

					SELECT * INTO v_live FROM subscription
						WHERE billing_account_id = v_account AND status IN ('trialing', 'active', 'past_due') FOR UPDATE;
					IF v_live.id IS NOT NULL AND (v_live.provider <> 'manual' OR v_live.period_end IS NULL OR v_live.period_end >= v_end) THEN
						-- A card subscription, an open-ended grant, or a grant reaching as far: never ended by an invoice.
						v_outcome := 'conflict';
					ELSE
						IF v_live.id IS NOT NULL THEN
							-- The previous period's grant (a renewal paid before it ends): replaced, the plan unbroken.
							UPDATE subscription SET status = 'canceled', period_end = greatest(coalesce(period_start, now()), now()), cancel_at_period_end = false
								WHERE id = v_live.id;
							INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
							VALUES (v_account, v_live.id, 'revoke', v_live.plan_code, now(), 'replaced: invoice ' || v_inv_ref || ' paid', 'invoice');
						END IF;
						INSERT INTO subscription (billing_account_id, plan_code, status, seats, period_start, period_end, trial_end,
						                          cancel_at_period_end, provider, external_ref, last_event_at, billing_interval)
							VALUES (v_account, v_plan, 'active', v_seats, v_start, v_end, NULL, true, 'manual', v_inv_ref, NULL, v_interval)
							RETURNING id INTO v_new;
						INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
						VALUES (v_account, v_new, 'grant', v_plan, v_end, 'invoice ' || v_inv_ref || ' paid', 'invoice');
						v_outcome := 'applied';
					END IF;
				END IF;
			END IF;
		END IF;

		-- 406: an event that applied to a subscription settles its open price conflicts (a corrected price, a cancellation).
		IF v_outcome = 'applied' AND v_apply THEN
			UPDATE billing_conflict SET resolved_at = now() WHERE provider = p_provider AND external_ref = v_ref AND resolved_at IS NULL;
		END IF;
		v_outcome := coalesce(v_outcome, 'recorded');
		-- 399: the subscription it names, so a delete that arrives before the subscription is remembered.
		UPDATE billing_event SET outcome = v_outcome, account_id = v_account, external_ref = v_ref WHERE provider = p_provider AND event_id = p_event_id;
		RETURN v_outcome;
	END
	$$;
