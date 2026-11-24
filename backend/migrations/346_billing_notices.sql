-- 346_billing_notices — the owners' billing emails: the grace started, the
-- pause landed, the reverse trial ends in 3 days (issue #641 § Downgrade or
-- lapse, "Reverse trial: yes, 14 days"; docs/billing.md § Plan emails).
--
-- 341 pauses the live catchments past Free's limit 14 days after a paid plan
-- ends, and 342 gives a newly verified person 14 days of Pro. Nobody was
-- told. The worker's tick (billing/planNotices.ts) now queues one email per
-- recipient for each, then sends the queued ones, each built as its
-- recipient: 329's renewal notice pattern.
--
--   1. billing_notice: one row per (account, kind, about, recipient), ever.
--      `about` names the occurrence: for 'grace' and 'paused' the account's
--      over_free_since (the grace's start, so a later lapse is a new grace
--      with its own emails), for 'trial_ending' the trial's trial_end. The
--      primary key makes each once: two ticks queueing at once insert one row
--      (ON CONFLICT DO NOTHING), and claiming moves it to `sending` under FOR
--      UPDATE SKIP LOCKED. The rows are kept (no purge) as the record that the
--      email went, and go with the account and with the person (ON DELETE
--      CASCADE from both).
--   2. Who: the account's owners, those who may change its plan
--      (app_billing_account_readable, 323): the person for a personal
--      account, every admin of the team for a team's.
--   3. app_billing_notice_queue(): the worker's own context only
--      (alert_worker_context, 051).
--        'grace'        billing enforced, the account past Free's limit
--                       (over_free_since) and still inside the 14 days, and
--                       nothing paused yet;
--        'paused'       billing enforced, and a catchment of the account
--                       paused (project_plan_pause);
--        'trial_ending' a reverse trial (342: manual + trialing, a person's
--                       account) ending within 3 days. Only a trial that
--                       exists: 342 grants none unless REVERSE_TRIAL and
--                       BILLING_ENFORCED are on. Stripe's own trials are left
--                       to Stripe's reminder email.
--      With enforcement off nothing pauses (341), so no grace or pause email
--      is queued: telling someone that something will pause when it won't
--      would be false.
--   4. app_billing_notice_claim / _finish: 133's and 329's lease; a sender
--      that dies mid-send leaves the email failed, never sent twice.
--   5. app_plan_pause_preview(account): for the account's owner (the
--      recipient, in the read-only transaction the email is built in), the
--      account's live catchments in 341's order, which one stays live and
--      which are (or would be) paused, so the grace email says what will
--      pause. A catchment the caller can't read comes back with no id (the
--      email counts it, never names it).
--
-- water_app reads its own rows only (the data export); every write is
-- through the definer functions. Covering indexes: billing_account_id leads
-- the primary key; user_id has its own.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
CREATE TABLE billing_notice (
	billing_account_id uuid NOT NULL REFERENCES billing_account (id) ON DELETE CASCADE,
	kind               text NOT NULL CHECK (kind IN ('grace', 'paused', 'trial_ending')),
	-- Which occurrence: the grace's start (over_free_since) or the trial's end (trial_end).
	about              timestamptz NOT NULL,
	user_id            uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
	status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
	attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	created_at         timestamptz NOT NULL DEFAULT now(),
	claimed_at         timestamptz,
	locked_until       timestamptz,
	sent_at            timestamptz,
	settled_at         timestamptz,
	reason             text CHECK (reason IS NULL OR char_length(reason) <= 200),
	PRIMARY KEY (billing_account_id, kind, about, user_id)
);
CREATE INDEX billing_notice_user_idx ON billing_notice (user_id);
CREATE INDEX billing_notice_open_idx ON billing_notice (status, created_at) WHERE status IN ('pending', 'sending');

COMMENT ON TABLE billing_notice IS
	'The owners'' billing emails (346, issue #641): the grace after a lapse started, the pause landed, a reverse trial ends in 3 days. One per account, kind, occurrence and recipient, ever. Own rows readable; written only by the worker''s definer functions. Kept as the record that the email went.';

ALTER TABLE billing_notice ENABLE ROW LEVEL SECURITY;
-- Reading only: no INSERT, UPDATE or DELETE policy.
CREATE POLICY billing_notice_own ON billing_notice FOR SELECT USING (user_id = app_current_user_id());
GRANT SELECT ON billing_notice TO water_app;

-- ---------------------------------------------------------------------------
-- 2–3. Queue
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_billing_notice_queue() RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer := 0;
		m integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker queues billing emails' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF coalesce(current_setting('app.billing_enforced', true), '') = 'on' THEN
			WITH owners AS (
				SELECT a.id, a.user_id AS uid FROM billing_account a WHERE a.kind = 'user' AND a.user_id IS NOT NULL
				UNION ALL
				SELECT a.id, m.user_id FROM billing_account a JOIN team_member m ON m.team_id = a.team_id AND m.role = 'admin'
				WHERE a.kind = 'team'
			), due AS (
				SELECT b.id, b.over_free_since,
					EXISTS (SELECT 1 FROM project_plan_pause pp JOIN project p ON p.id = pp.project_id WHERE p.billing_account_id = b.id) AS paused
				FROM billing_account b
				WHERE b.over_free_since IS NOT NULL
			)
			INSERT INTO billing_notice (billing_account_id, kind, about, user_id)
			SELECT d.id, CASE WHEN d.paused THEN 'paused' ELSE 'grace' END, d.over_free_since, o.uid
			FROM due d JOIN owners o ON o.id = d.id
			-- A grace first seen already over (enforcement turned on late) gets only the pause email.
			WHERE d.paused OR d.over_free_since > now() - interval '14 days'
			ON CONFLICT (billing_account_id, kind, about, user_id) DO NOTHING;
			GET DIAGNOSTICS n = ROW_COUNT;
		END IF;
		-- The literal provider and status use 342's partial index on trial_end.
		INSERT INTO billing_notice (billing_account_id, kind, about, user_id)
		SELECT s.billing_account_id, 'trial_ending', s.trial_end, a.user_id
		FROM subscription s
		JOIN billing_account a ON a.id = s.billing_account_id AND a.kind = 'user' AND a.user_id IS NOT NULL
		WHERE s.provider = 'manual' AND s.status = 'trialing'
		  AND s.trial_end > now() AND s.trial_end <= now() + interval '3 days'
		ON CONFLICT (billing_account_id, kind, about, user_id) DO NOTHING;
		GET DIAGNOSTICS m = ROW_COUNT;
		RETURN n + m;
	END
	$$;

-- ---------------------------------------------------------------------------
-- 4. Claim and finish (329's pattern)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_billing_notice_claim(p_limit integer, p_lease interval)
	RETURNS TABLE (billing_account_id uuid, kind text, about timestamptz, user_id uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends billing emails' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim 1–500 emails with a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE billing_notice n SET status = 'failed', locked_until = NULL, settled_at = now(), reason = 'the worker stopped while sending'
		WHERE n.status = 'sending' AND n.locked_until < now();
		RETURN QUERY
			WITH due AS (
				SELECT n.billing_account_id, n.kind, n.about, n.user_id FROM billing_notice n
				WHERE n.status = 'pending'
				ORDER BY n.created_at, n.billing_account_id, n.kind, n.about, n.user_id
				LIMIT p_limit
				FOR UPDATE SKIP LOCKED
			), claimed AS (
				UPDATE billing_notice n SET status = 'sending', claimed_at = now(), locked_until = now() + p_lease, attempts = n.attempts + 1
				FROM due d
				WHERE n.billing_account_id = d.billing_account_id AND n.kind = d.kind AND n.about = d.about AND n.user_id = d.user_id
				RETURNING n.billing_account_id, n.kind, n.about, n.user_id, n.created_at
			)
			SELECT c.billing_account_id, c.kind, c.about, c.user_id FROM claimed c
			ORDER BY c.created_at, c.billing_account_id, c.kind, c.about, c.user_id;
	END
	$$;

CREATE FUNCTION app_billing_notice_finish(p_account uuid, p_kind text, p_about timestamptz, p_user uuid, p_status text, p_reason text DEFAULT NULL)
	RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends billing emails' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_status IS NULL OR p_status NOT IN ('sent', 'skipped', 'failed', 'retry') THEN
			RAISE EXCEPTION 'unknown email outcome' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE billing_notice n SET
			status = CASE WHEN p_status <> 'retry' THEN p_status WHEN n.attempts >= 3 THEN 'failed' ELSE 'pending' END,
			sent_at = CASE WHEN p_status = 'sent' THEN now() END,
			settled_at = CASE WHEN p_status <> 'retry' OR n.attempts >= 3 THEN now() END,
			locked_until = NULL,
			reason = left(p_reason, 200)
		WHERE n.billing_account_id = p_account AND n.kind = p_kind AND n.about = p_about AND n.user_id = p_user AND n.status = 'sending';
		RETURN FOUND;
	END
	$$;

REVOKE ALL ON FUNCTION app_billing_notice_queue(), app_billing_notice_claim(integer, interval),
	app_billing_notice_finish(uuid, text, timestamptz, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_billing_notice_queue(), app_billing_notice_claim(integer, interval),
	app_billing_notice_finish(uuid, text, timestamptz, uuid, text, text) TO water_app;

-- ---------------------------------------------------------------------------
-- 5. What pauses: 341's order, for the account's owner
-- ---------------------------------------------------------------------------
-- From app_plan_pause_sync's (341) ordering: the kept catchment first, else the most recently active. `keeps`: within
-- Free's limit; `paused`: a marker now. project_id is null for a catchment the caller can't read.
CREATE FUNCTION app_plan_pause_preview(p_account uuid)
	RETURNS TABLE (project_id uuid, keeps boolean, paused boolean)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_kept uuid;
		v_limit bigint;
	BEGIN
		IF NOT app_billing_account_readable(p_account) THEN
			RETURN;
		END IF;
		SELECT b.kept_project_id INTO v_kept FROM billing_account b WHERE b.id = p_account;
		SELECT (limits ->> 'live_catchments')::bigint INTO v_limit FROM plan WHERE code = 'free';
		IF v_limit IS NULL THEN
			RETURN;
		END IF;
		RETURN QUERY
			WITH live AS (
				SELECT p.id, row_number() OVER (
					ORDER BY (p.id IS NOT DISTINCT FROM v_kept) DESC,
						greatest(p.updated_at, (SELECT max(r.created_at) FROM model_run r WHERE r.project_id = p.id)) DESC NULLS LAST,
						p.id) AS rn
				FROM project p
				WHERE p.billing_account_id = p_account AND app_project_live_except(p.id, NULL, NULL, NULL, false)
			)
			SELECT CASE WHEN app_has_role(l.id, 'viewer') THEN l.id END, l.rn <= v_limit,
				EXISTS (SELECT 1 FROM project_plan_pause pp WHERE pp.project_id = l.id)
			FROM live l
			ORDER BY l.rn;
	END
	$$;
REVOKE ALL ON FUNCTION app_plan_pause_preview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_plan_pause_preview(uuid) TO water_app;
COMMENT ON FUNCTION app_plan_pause_preview(uuid) IS
	'The account''s live catchments in 341''s order: which stays live past Free''s limit and which are (or will be) paused (346, the owners'' emails). Only for the account''s owner; a catchment the caller can''t read has no id.';
