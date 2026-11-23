-- 327_billing_event_order — the webhook's two gates before BILLING_PROVIDER=stripe
-- (issue #641; docs/followups.md § Billing; docs/data-model.md § Billing events).
--
--   1. Order. Stripe doesn't deliver events in the order it created them, so an
--      older customer.subscription.updated arriving after a newer one used to
--      overwrite the newer state (326 applied in arrival order).
--      subscription.last_event_at keeps the provider's time (the payload's
--      eventCreated) of the newest event applied to it, and app_billing_apply,
--      redefined from 326, answers 'stale' for an update older than that,
--      changing nothing and recording the event (so its retry is a duplicate).
--        - An equal time applies (arrival order breaks the tie): Stripe's
--          created is whole seconds, and two real changes in one second must
--          not lose the second one.
--        - A missing or null eventCreated (the mock and manual providers, an
--          older sender) applies in arrival order, as in 326, and leaves
--          last_event_at as it was; a malformed one is 'invalid'.
--        - A delete is never stale: it is the provider's last word, and the
--          existing rule (an ended subscription stays ended) already refuses
--          a late live update after it.
--      last_event_at is null on rows written before 327 and by the staff
--      grant (323), so the first timed event after them applies.
--   2. Purge. app_purge_billing_events(p_age): the job tick deletes
--      billing_event rows received more than 90 days ago
--      (jobs/runner.ts BILLING_EVENT_RETENTION_DAYS), from the worker's
--      context only (051's alert_worker_context), and never under 4 days:
--      Stripe redelivers for up to 3, and a row purged inside that window
--      would let a redelivery apply again. Uses 326's received_at index.

-- ---------------------------------------------------------------------------
-- 1. Order
-- ---------------------------------------------------------------------------
ALTER TABLE subscription ADD COLUMN last_event_at timestamptz;
COMMENT ON COLUMN subscription.last_event_at IS
	'The provider''s creation time of the newest webhook event applied to this subscription (327); an older update is skipped as stale. Null before 327, for the staff grant, and while no event carried a time.';

ALTER TABLE billing_event DROP CONSTRAINT billing_event_outcome_check;
ALTER TABLE billing_event ADD CONSTRAINT billing_event_outcome_check
	CHECK (outcome IN ('applied', 'recorded', 'conflict', 'unknown_account', 'stale'));

-- From 326's definition, with eventCreated read and checked, the stale branch, and last_event_at written.
-- Return values: 326's, plus 'stale' (older than the event last applied to the subscription; recorded, nothing changed).
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
		v_created timestamptz;
		v_sub subscription;
		v_outcome text;
		v_iso constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$';
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
			END IF;
		ELSIF p_payload IS NOT NULL AND jsonb_typeof(p_payload) = 'object'
		      AND (p_payload ->> 'accountId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
			-- A record-only event names its account when it can; nothing is checked or applied.
			v_account := (p_payload ->> 'accountId')::uuid;
		END IF;

		-- 1. De-duplicate: the first delivery of (provider, event_id) wins.
		INSERT INTO billing_event (provider, event_id, type, outcome) VALUES (p_provider, p_event_id, p_type, 'recorded')
			ON CONFLICT (provider, event_id) DO NOTHING;
		IF NOT FOUND THEN
			RETURN 'duplicate';
		END IF;

		-- Lock the account, so two events for one account apply one after the other (the one-live index stays a backstop).
		IF v_account IS NOT NULL THEN
			PERFORM 1 FROM billing_account WHERE id = v_account FOR UPDATE;
			IF NOT FOUND THEN
				v_account := NULL;
				v_outcome := CASE WHEN v_apply THEN 'unknown_account' ELSE 'recorded' END;
			END IF;
		END IF;

		IF v_outcome IS NULL AND v_apply THEN
			SELECT * INTO v_sub FROM subscription WHERE provider = p_provider AND external_ref = v_ref FOR UPDATE;
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
			ELSIF v_status IN ('trialing', 'active', 'past_due') AND EXISTS (
				SELECT 1 FROM subscription
				WHERE billing_account_id = v_account AND status IN ('trialing', 'active', 'past_due')
				  AND id IS DISTINCT FROM v_sub.id
			) THEN
				v_outcome := 'conflict';
			ELSIF v_sub.id IS NULL THEN
				INSERT INTO subscription (billing_account_id, plan_code, status, seats, period_start, period_end, trial_end,
				                          cancel_at_period_end, provider, external_ref, last_event_at)
					VALUES (v_account, v_plan, v_status, v_seats, v_start, v_end, v_trial, v_cancel_at_end, p_provider, v_ref, v_created);
				v_outcome := 'applied';
			ELSE
				UPDATE subscription SET plan_code = v_plan, status = v_status, seats = v_seats, period_start = v_start,
				                        period_end = v_end, trial_end = v_trial, cancel_at_period_end = v_cancel_at_end,
				                        last_event_at = greatest(last_event_at, v_created)
					WHERE id = v_sub.id;
				v_outcome := 'applied';
			END IF;
		END IF;

		v_outcome := coalesce(v_outcome, 'recorded');
		UPDATE billing_event SET outcome = v_outcome, account_id = v_account WHERE provider = p_provider AND event_id = p_event_id;
		RETURN v_outcome;
	END
	$$;

-- ---------------------------------------------------------------------------
-- 2. Purge
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_purge_billing_events(p_age interval) RETURNS integer
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
		RETURN v_count;
	END
	$$;
REVOKE ALL ON FUNCTION app_purge_billing_events(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_billing_events(interval) TO water_app;
