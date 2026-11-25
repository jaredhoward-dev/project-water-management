-- 353_render_slot — a render request is sent only when the renderer can take
-- it (docs/architecture.md § Server-side reports, § Render slots).
--
-- The worker issued a 5-minute render token and sent the request to the
-- renderer Lambda's queue whenever a report_render (or pack_render,
-- applicant_pack_render) job ran. The renderer runs only RENDER_CONCURRENCY
-- renders at a time (infra/reports.tf, its SQS trigger's
-- maximum_concurrency), so a burst (many Monday 07:00 schedules) left
-- requests waiting in SQS past their token's life; the renderer answered them
-- "expired, retry" without a browser, and the worker's three requests could
-- all be spent that way. Now a request waits in our own queue (the job
-- table) for a slot, and its token is issued only once it has one.
--
--   render_slot   one row per render target (report:<id>, pack:<id>,
--                 applicant_pack:<pack id>): 'waiting' (asked, no slot yet,
--                 in the order first asked, seq; job_id the job that asks)
--                 or 'sent' (in flight; request_id names that one request).
--                 Not project data: no grants, read and written only through
--                 the functions below, from the worker's context.
--
-- app_render_slot_take(target, limit, job) → boolean: true when the target
--   may send now: fewer than `limit` are in flight and no waiter asked before
--   it for the free slots. Otherwise it joins (or stays in) the waiting line
--   and answers false; the job is handed back (JobRelease) and asks again.
--   Rows past their expiry are deleted first: an in-flight slot whose answer
--   never came (lost, dead-lettered) frees itself RENDER_SLOT_TTL after it
--   was taken (a token's 5 minutes, a render's 120 s, a margin), and a waiter
--   that stopped asking (its report deleted) leaves the line as long after
--   its last ask. A target already in flight waits (a second request of one
--   report is never sent beside the first).
-- app_render_slot_sent(target, request) → boolean: names the request sent on
--   the slot just taken (reports/renderSlots.ts renderRequestId: a digest of
--   its render token, which the renderer echoes in its answer), before it is
--   sent.
-- app_render_slot_free(target, request) → boolean: the renderer answered
--   (lambda-worker.ts, on its render-results message, whatever the answer),
--   or the send failed: the slot is free at once, but only when the answer
--   is for the request now in flight. A late or redelivered answer of an
--   earlier request (an SQS redelivery, the first answer after an expired
--   request was asked again, the answer of a slot that timed out and was
--   taken again) frees nothing, or more renders than the limit would run at
--   once. An answer without a request id (a renderer older than this
--   migration) matches only a slot not yet named, so it frees nothing it
--   can't prove is its own; such a slot frees on its 10 minutes.
--
-- Whenever a slot frees (an answer, a failed send, an expired slot reclaimed
-- by a take), the oldest waiter whose job is still queued is made due now and
-- the worker is woken (NOTIFY job_queued, as a job insert does; in
-- production the answer's own worker invocation runs the tick that claims
-- it), so a free slot never idles until the 5-minute tick.
CREATE TABLE render_slot (
	target      text PRIMARY KEY CHECK (target ~ '^(report|pack|applicant_pack):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	-- The waiting line's order: first asked, first sent.
	seq         bigint GENERATED ALWAYS AS IDENTITY,
	state       text NOT NULL CHECK (state IN ('waiting', 'sent')),
	asked_at    timestamptz NOT NULL DEFAULT now(),
	sent_at     timestamptz,
	expires_at  timestamptz NOT NULL,
	-- The job asking for the slot (the last ask's): made due when a slot frees. Not a foreign key: a finished job is purged.
	job_id      uuid,
	-- The request in flight (state 'sent'), once named (app_render_slot_sent): only its answer frees the slot.
	request_id  text CHECK (request_id ~ '^[0-9a-f]{32}$'),
	CHECK (state = 'sent' OR request_id IS NULL)
);
CREATE INDEX render_slot_line_idx ON render_slot (state, seq);
ALTER TABLE render_slot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON render_slot FROM PUBLIC, water_app;
COMMENT ON TABLE render_slot IS
	'Render requests in flight to the renderer Lambda, and those waiting for a slot (353). No grants: only app_render_slot_take / _sent / _free, from the worker''s context.';

-- Make the oldest `p_n` waiters whose jobs are still queued due now, and wake
-- the worker. Called only from the SECURITY DEFINER functions below, so it
-- runs as their owner; not a definer itself, and no grant: water_app can't
-- call it, nor touch render_slot or job.run_after if it could.
CREATE FUNCTION app_render_slot_wake(p_n integer) RETURNS void
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		v_n integer;
	BEGIN
		IF p_n IS NULL OR p_n < 1 THEN
			RETURN;
		END IF;
		UPDATE job SET run_after = now()
			WHERE id IN (
				SELECT s.job_id FROM render_slot s JOIN job j ON j.id = s.job_id
				WHERE s.state = 'waiting' AND j.status = 'queued'
				ORDER BY s.seq LIMIT p_n
			) AND run_after > now();
		GET DIAGNOSTICS v_n = ROW_COUNT;
		IF v_n > 0 THEN
			-- Wakes the local worker at commit (LISTEN job_queued, jobs/worker.ts), as a job insert does.
			PERFORM pg_notify('job_queued', '');
		END IF;
	END
	$$;
REVOKE ALL ON FUNCTION app_render_slot_wake(integer) FROM PUBLIC, water_app;

CREATE FUNCTION app_render_slot_take(p_target text, p_limit integer, p_job uuid) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_ttl constant interval := interval '10 minutes';
		v_state text;
		v_seq bigint;
		v_busy integer;
		v_expired integer;
	BEGIN
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
			RAISE EXCEPTION 'a render slot limit is 1 to 100' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		-- The worker's context only (no signed-in user): a member never takes or frees a slot.
		IF app_current_user_id() IS NOT NULL THEN
			RAISE EXCEPTION 'render slots are the worker''s' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- One taker at a time: several worker invocations run at once.
		PERFORM pg_advisory_xact_lock(hashtext('render_slot'));
		WITH gone AS (DELETE FROM render_slot WHERE expires_at <= now() RETURNING state)
			SELECT count(*) FILTER (WHERE state = 'sent') INTO v_expired FROM gone;
		INSERT INTO render_slot (target, state, expires_at, job_id) VALUES (p_target, 'waiting', now() + v_ttl, p_job)
			ON CONFLICT (target) DO UPDATE SET
				-- A waiter's ask keeps its place in line (and names the job asking now); an in-flight slot keeps its own.
				expires_at = CASE WHEN render_slot.state = 'waiting' THEN now() + v_ttl ELSE render_slot.expires_at END,
				job_id = CASE WHEN render_slot.state = 'waiting' THEN p_job ELSE render_slot.job_id END
			RETURNING state, seq INTO v_state, v_seq;
		-- In-flight slots that expired are free: the waiters next in line needn't wait for their own next ask.
		PERFORM app_render_slot_wake(v_expired);
		IF v_state = 'sent' THEN
			RETURN false;
		END IF;
		SELECT count(*) INTO v_busy FROM render_slot
			WHERE state = 'sent' OR (state = 'waiting' AND seq < v_seq);
		IF v_busy >= p_limit THEN
			RETURN false;
		END IF;
		UPDATE render_slot SET state = 'sent', sent_at = now(), expires_at = now() + v_ttl, request_id = NULL WHERE target = p_target;
		RETURN true;
	END
	$$;

CREATE FUNCTION app_render_slot_sent(p_target text, p_request text) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_n integer;
	BEGIN
		IF app_current_user_id() IS NOT NULL THEN
			RAISE EXCEPTION 'render slots are the worker''s' USING ERRCODE = 'insufficient_privilege';
		END IF;
		UPDATE render_slot SET request_id = p_request WHERE target = p_target AND state = 'sent' AND request_id IS NULL;
		GET DIAGNOSTICS v_n = ROW_COUNT;
		RETURN v_n > 0;
	END
	$$;

CREATE FUNCTION app_render_slot_free(p_target text, p_request text) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_n integer;
	BEGIN
		IF app_current_user_id() IS NOT NULL THEN
			RAISE EXCEPTION 'render slots are the worker''s' USING ERRCODE = 'insufficient_privilege';
		END IF;
		PERFORM pg_advisory_xact_lock(hashtext('render_slot'));
		-- Only the request in flight: a stale answer (another request's id) frees nothing. No id matches only an unnamed slot.
		DELETE FROM render_slot WHERE target = p_target AND state = 'sent' AND request_id IS NOT DISTINCT FROM p_request;
		GET DIAGNOSTICS v_n = ROW_COUNT;
		IF v_n > 0 THEN
			PERFORM app_render_slot_wake(1);
		END IF;
		RETURN v_n > 0;
	END
	$$;

REVOKE ALL ON FUNCTION app_render_slot_take(text, integer, uuid), app_render_slot_sent(text, text), app_render_slot_free(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_render_slot_take(text, integer, uuid), app_render_slot_sent(text, text), app_render_slot_free(text, text) TO water_app;

-- A report's answer window counts from when its request was sent, not from
-- when it was asked for: a report that waited for a slot hasn't been with
-- the renderer meanwhile (reports/store.ts reportState). A request asked
-- again (requestRenderAgain) that waits for a slot moves it to each ask, so
-- a live wait never reads as an unanswered send, and a wait whose job stops
-- asking still fails the report an hour later.
ALTER TABLE report ADD COLUMN sent_at timestamptz;
GRANT UPDATE (sent_at) ON report TO water_app;
