-- 329_renewal_notice — the annual renewal notice's sent-log (issue #641 §
-- Billing provider; docs/billing.md § Renewal notice).
--
-- The Consumer Protection Act s14(2)(c) has a supplier tell an individual on
-- a fixed-term agreement, 40 to 80 business days before it ends, that it is
-- ending and what they can do. The worker's tick (billing/renewal.ts) queues
-- one renewal_notice per subscription and period when the period's end is 60
-- business days away (or less, down to a margin above 40, so a missed day
-- still sends), then sends the queued ones, each built as its recipient.
--
--   1. renewal_notice: one row per (subscription, period_end), ever. The
--      primary key is what makes it once: two ticks queueing at once insert
--      one row (ON CONFLICT DO NOTHING), and claiming moves it to `sending`
--      under FOR UPDATE SKIP LOCKED, so two senders never both get it. A
--      renewed period has a new period_end and gets its own notice. The rows
--      are the record that the notice went, so they are kept (no purge) and
--      go with the subscription (ON DELETE CASCADE from it, and so from the
--      account and its person).
--   2. Who: a live (active or past_due) subscription that doesn't already end
--      at its period end, on a person's account (billing_account.kind
--      'user': s14(1) leaves out agreements between juristic persons, and a team's
--      account is its organisation's), whose period is a year. subscription
--      records no billing interval, so a year is read from the period itself:
--      period_end − period_start of 300 days or more (a monthly period is at
--      most 31 days and a trial's at most plan.trial_days ≤ 365, but a
--      trialing subscription is never picked). The Stripe subscription's
--      current period is exactly its interval (provider/stripe.ts), so this
--      needs no new column for app_billing_apply to keep.
--   3. app_renewal_notice_queue(from, to) / _claim / _finish: the worker's
--      own context only (alert_worker_context, 051), like 133's pack notices.
--      The business days are the backend's (billing/businessDays.ts, with
--      South Africa's public holidays); the queue takes the range of end
--      dates, as SAST calendar dates, that are due today.
--
-- water_app reads its own rows only (a person's own notices, for the data
-- export); every write is through the definer functions.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
CREATE TABLE renewal_notice (
	subscription_id uuid NOT NULL REFERENCES subscription (id) ON DELETE CASCADE,
	-- The end of the period the notice is about; a renewed period is another notice.
	period_end      timestamptz NOT NULL,
	user_id         uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
	status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
	attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	created_at      timestamptz NOT NULL DEFAULT now(),
	claimed_at      timestamptz,
	locked_until    timestamptz,
	sent_at         timestamptz,
	settled_at      timestamptz,
	reason          text CHECK (reason IS NULL OR char_length(reason) <= 200),
	PRIMARY KEY (subscription_id, period_end)
);
CREATE INDEX renewal_notice_user_idx ON renewal_notice (user_id);
CREATE INDEX renewal_notice_open_idx ON renewal_notice (status, created_at) WHERE status IN ('pending', 'sending');

COMMENT ON TABLE renewal_notice IS
	'One annual renewal notice per subscription and period, ever (329, issue #641; CPA s14). Own rows readable; written only by the worker''s definer functions. Kept as the record that the notice went; goes with the subscription.';

ALTER TABLE renewal_notice ENABLE ROW LEVEL SECURITY;
-- Reading only: no INSERT, UPDATE or DELETE policy.
CREATE POLICY renewal_notice_own ON renewal_notice FOR SELECT USING (user_id = app_current_user_id());
GRANT SELECT ON renewal_notice TO water_app;

-- ---------------------------------------------------------------------------
-- 2. Queue: the subscriptions whose period ends on a date in [p_from, p_to]
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_renewal_notice_queue(p_from date, p_to date) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker queues renewal notices' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 60
			OR p_from < (now() AT TIME ZONE 'Africa/Johannesburg')::date THEN
			RAISE EXCEPTION 'queue for a range of at most 60 days, from today on' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		INSERT INTO renewal_notice (subscription_id, period_end, user_id)
		SELECT s.id, s.period_end, a.user_id
		FROM subscription s
		JOIN billing_account a ON a.id = s.billing_account_id
		WHERE a.kind = 'user'
		  AND s.status IN ('active', 'past_due')
		  AND NOT s.cancel_at_period_end
		  AND s.period_start IS NOT NULL AND s.period_end IS NOT NULL
		  AND s.period_end - s.period_start >= interval '300 days'
		  AND (s.period_end AT TIME ZONE 'Africa/Johannesburg')::date BETWEEN p_from AND p_to
		ON CONFLICT (subscription_id, period_end) DO NOTHING;
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;

-- ---------------------------------------------------------------------------
-- 3. Claim and finish (133's pattern: a lease; a sender that dies mid-send
--    leaves the notice failed, never sent twice)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_renewal_notice_claim(p_limit integer, p_lease interval)
	RETURNS TABLE (subscription_id uuid, period_end timestamptz, user_id uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends renewal notices' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim 1–500 notices with a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE renewal_notice n SET status = 'failed', locked_until = NULL, settled_at = now(), reason = 'the worker stopped while sending'
		WHERE n.status = 'sending' AND n.locked_until < now();
		RETURN QUERY
			WITH due AS (
				SELECT n.subscription_id, n.period_end FROM renewal_notice n
				WHERE n.status = 'pending'
				ORDER BY n.created_at, n.subscription_id, n.period_end
				LIMIT p_limit
				FOR UPDATE SKIP LOCKED
			), claimed AS (
				UPDATE renewal_notice n SET status = 'sending', claimed_at = now(), locked_until = now() + p_lease, attempts = n.attempts + 1
				FROM due d WHERE n.subscription_id = d.subscription_id AND n.period_end = d.period_end
				RETURNING n.subscription_id, n.period_end, n.user_id, n.created_at
			)
			SELECT c.subscription_id, c.period_end, c.user_id FROM claimed c
			ORDER BY c.created_at, c.subscription_id, c.period_end;
	END
	$$;

CREATE FUNCTION app_renewal_notice_finish(p_subscription uuid, p_period_end timestamptz, p_status text, p_reason text DEFAULT NULL) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends renewal notices' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_status IS NULL OR p_status NOT IN ('sent', 'skipped', 'failed', 'retry') THEN
			RAISE EXCEPTION 'unknown notice outcome' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE renewal_notice n SET
			status = CASE WHEN p_status <> 'retry' THEN p_status WHEN n.attempts >= 3 THEN 'failed' ELSE 'pending' END,
			sent_at = CASE WHEN p_status = 'sent' THEN now() END,
			settled_at = CASE WHEN p_status <> 'retry' OR n.attempts >= 3 THEN now() END,
			locked_until = NULL,
			reason = left(p_reason, 200)
		WHERE n.subscription_id = p_subscription AND n.period_end = p_period_end AND n.status = 'sending';
		RETURN FOUND;
	END
	$$;

REVOKE ALL ON FUNCTION app_renewal_notice_queue(date, date), app_renewal_notice_claim(integer, interval),
	app_renewal_notice_finish(uuid, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_renewal_notice_queue(date, date), app_renewal_notice_claim(integer, interval),
	app_renewal_notice_finish(uuid, timestamptz, text, text) TO water_app;
