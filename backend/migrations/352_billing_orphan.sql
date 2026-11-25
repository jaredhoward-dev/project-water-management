-- 352_billing_orphan — a subscription made for an account that is gone is
-- cancelled and refunded (issue #641; docs/billing.md § Deleting an account,
-- § Webhooks and providers; docs/followups.md § Billing).
--
-- Deleting an account expires its open Checkout sessions and cancels its
-- subscriptions first (round 2), but a checkout started in another tab in the
-- moment before the delete commits, and paid after, makes the provider create
-- a subscription for an account that no longer exists. app_billing_apply
-- answers its subscription events `unknown_account` (and the session's
-- checkout.completed `recorded`, with no account), and the card is charged.
-- The webhook route (billing/webhook.ts) now cancels that subscription at the
-- provider and refunds what was paid for it. This migration gives it the two
-- steps of state it needs on the event row, so a failure is retried and a
-- success is never repeated:
--
--   'orphan_pending'  the event brought a live subscription (or a completed
--                     checkout) whose account can't be found; the cancel and
--                     refund haven't succeeded yet. The route answers it 503,
--                     so the provider redelivers it, and the redelivery (a
--                     duplicate to app_billing_apply) finds it here and tries
--                     again.
--   'orphan_refunded' cancelled at the provider and its first invoice refunded
--                     (or nothing was paid, a trial, or a live one whose first
--                     invoice is past the refund window: cancelled only): done;
--                     a redelivery is a plain duplicate.
--   'orphan_skipped_old' the provider had it ended already and its first invoice
--                     was paid before the refund window (stripeApi.ts
--                     ORPHAN_REFUND_WINDOW_SECONDS): a late or out-of-order
--                     event about a subscription its account paid for and used,
--                     so nothing is cancelled or refunded: done.
--
-- app_billing_orphan_claim(provider, event_id, first) → boolean, called in the
-- same transaction as app_billing_apply (so no crash can leave an orphan
-- recorded and forgotten):
--   first = true  (this delivery inserted the row): an `unknown_account`
--                 row, or a `checkout.completed` row `recorded` with no
--                 account, becomes `orphan_pending`; answers true. Which
--                 events are live subscriptions is the route's call (it reads
--                 the normalised status); the SQL only checks the row says the
--                 account was unknown when this delivery applied it.
--   first = false (a redelivery, app_billing_apply answered `duplicate`):
--                 true only for a row already `orphan_pending`. A redelivered
--                 event whose account was deleted *after* it first applied
--                 is never taken for an orphan (its row isn't pending).
-- app_billing_orphan_done(provider, event_id, outcome) → boolean:
--   `orphan_pending` → outcome (`orphan_refunded` or `orphan_skipped_old`; any
--   other raises 22023); false when the row wasn't pending (a concurrent
--   delivery finished first).
--
-- Both are SECURITY DEFINER with a pinned search_path, run with no user (as
-- app_billing_apply: 42501 inside a user's or an API key's transaction), and
-- are granted to water_app. billing_event stays owner-only: no new table,
-- column, policy or table grant. 327's purge removes these rows with the rest
-- after 90 days, well past Stripe's 3-day redelivery window.

ALTER TABLE billing_event DROP CONSTRAINT billing_event_outcome_check;
ALTER TABLE billing_event ADD CONSTRAINT billing_event_outcome_check
	CHECK (outcome IN ('applied', 'recorded', 'conflict', 'unknown_account', 'stale', 'orphan_pending', 'orphan_refunded', 'orphan_skipped_old'));

CREATE FUNCTION app_billing_orphan_claim(p_provider text, p_event_id text, p_first boolean) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_outcome text;
	BEGIN
		IF app_current_user_id() IS NOT NULL OR nullif(current_setting('app.current_api_key_id', true), '') IS NOT NULL THEN
			RAISE EXCEPTION 'app_billing_orphan_claim runs with no user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_first THEN
			UPDATE billing_event SET outcome = 'orphan_pending'
				WHERE provider = p_provider AND event_id = p_event_id AND account_id IS NULL
					AND (outcome = 'unknown_account' OR (outcome = 'recorded' AND type = 'checkout.completed'))
				RETURNING outcome INTO v_outcome;
			RETURN v_outcome IS NOT NULL;
		END IF;
		SELECT outcome INTO v_outcome FROM billing_event WHERE provider = p_provider AND event_id = p_event_id;
		RETURN v_outcome = 'orphan_pending';
	END
	$$;
REVOKE ALL ON FUNCTION app_billing_orphan_claim(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_billing_orphan_claim(text, text, boolean) TO water_app;

CREATE FUNCTION app_billing_orphan_done(p_provider text, p_event_id text, p_outcome text) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF app_current_user_id() IS NOT NULL OR nullif(current_setting('app.current_api_key_id', true), '') IS NOT NULL THEN
			RAISE EXCEPTION 'app_billing_orphan_done runs with no user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_outcome IS NULL OR p_outcome NOT IN ('orphan_refunded', 'orphan_skipped_old') THEN
			RAISE EXCEPTION 'app_billing_orphan_done: unknown outcome' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE billing_event SET outcome = p_outcome
			WHERE provider = p_provider AND event_id = p_event_id AND outcome = 'orphan_pending';
		RETURN FOUND;
	END
	$$;
REVOKE ALL ON FUNCTION app_billing_orphan_done(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_billing_orphan_done(text, text, text) TO water_app;
