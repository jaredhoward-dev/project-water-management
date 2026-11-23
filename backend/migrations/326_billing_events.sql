-- 326_billing_events — the billing provider's webhook events: de-duplication
-- and app_billing_apply, the only writer of subscription status (issue #641
-- Phase 3; docs/data-model.md § Billing events).
--
--   1. billing_event: one row per (provider, event_id) the webhook has acted
--      on, so a replayed delivery changes nothing (threkir's webhook_events
--      pattern). Owner-only: RLS on, no policy, no privilege for water_app;
--      only app_billing_apply writes it. outcome is what the event did
--      (applied, recorded, conflict, unknown_account), for the operator.
--      account_id is SET NULL when the account goes (deleting a person takes
--      their billing account, 323); the event ids are the provider's, not
--      personal information.
--   2. app_billing_apply(provider, event_id, type, payload): called by the
--      webhook route (lane W, backend/src/billing/) inside withoutUser, as
--      water_app, with a payload the route has already verified and
--      normalised (never a raw provider object). SECURITY DEFINER, since
--      water_app has SELECT only on subscription (323). Never raises on a bad
--      payload: it answers 'invalid' and records nothing, so the provider's
--      retry of a corrected event isn't taken for a duplicate.
--
-- Return values: 'applied' (a subscription row changed), 'recorded' (an event
-- type with nothing to apply, or a cancel of a subscription we don't hold),
-- 'duplicate' (seen before; nothing changed), 'conflict' (it would move a
-- subscription to another account, make a second live subscription on the
-- account, or bring a canceled or expired one back to life; nothing changed),
-- 'unknown_account' (no such billing account; nothing changed), 'invalid'.
-- conflict and unknown_account are recorded, so a replay is a duplicate.

-- ---------------------------------------------------------------------------
-- 1. billing_event
-- ---------------------------------------------------------------------------
CREATE TABLE billing_event (
	provider    text NOT NULL CHECK (provider IN ('mock', 'manual', 'stripe')),
	event_id    text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 255),
	type        text NOT NULL CHECK (length(type) BETWEEN 1 AND 100),
	received_at timestamptz NOT NULL DEFAULT now(),
	account_id  uuid REFERENCES billing_account (id) ON DELETE SET NULL,
	outcome     text NOT NULL CHECK (outcome IN ('applied', 'recorded', 'conflict', 'unknown_account')),
	PRIMARY KEY (provider, event_id)
);
CREATE INDEX billing_event_account_idx ON billing_event (account_id);
-- For a future purge of rows past the providers' retry windows (Stripe retries for 3 days).
CREATE INDEX billing_event_received_idx ON billing_event (received_at);
COMMENT ON TABLE billing_event IS
	'Billing provider webhook events acted on, one per (provider, event_id), so a replay changes nothing (326, issue #641). Written only by app_billing_apply; owner-only.';

ALTER TABLE billing_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billing_event FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- 2. app_billing_apply
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_billing_apply(p_provider text, p_event_id text, p_type text, p_payload jsonb) RETURNS text
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
					UPDATE subscription SET status = 'canceled', cancel_at_period_end = false WHERE id = v_sub.id;
					v_outcome := 'applied';
				END IF;
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
				                          cancel_at_period_end, provider, external_ref)
					VALUES (v_account, v_plan, v_status, v_seats, v_start, v_end, v_trial, v_cancel_at_end, p_provider, v_ref);
				v_outcome := 'applied';
			ELSE
				UPDATE subscription SET plan_code = v_plan, status = v_status, seats = v_seats, period_start = v_start,
				                        period_end = v_end, trial_end = v_trial, cancel_at_period_end = v_cancel_at_end
					WHERE id = v_sub.id;
				v_outcome := 'applied';
			END IF;
		END IF;

		v_outcome := coalesce(v_outcome, 'recorded');
		UPDATE billing_event SET outcome = v_outcome, account_id = v_account WHERE provider = p_provider AND event_id = p_event_id;
		RETURN v_outcome;
	END
	$$;
REVOKE ALL ON FUNCTION app_billing_apply(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_billing_apply(text, text, text, jsonb) TO water_app;
