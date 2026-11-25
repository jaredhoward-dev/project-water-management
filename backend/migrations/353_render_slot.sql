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
--                 in the order first asked, seq) or 'sent' (in flight). Not
--                 project data: no grants, read and written only through the
--                 functions below, from the worker's context.
--
-- app_render_slot_take(target, limit) → boolean: true when the target may
--   send now: fewer than `limit` are in flight and no waiter asked before it
--   for the free slots. Otherwise it joins (or stays in) the waiting line and
--   answers false; the job is handed back (JobRelease) and asks again. Rows
--   past their expiry are deleted first: an in-flight slot whose answer never
--   came (lost, dead-lettered) frees itself RENDER_SLOT_TTL after it was
--   taken (a token's 5 minutes, a render's 120 s, a margin), and a waiter
--   that stopped asking (its report deleted) leaves the line as long after
--   its last ask. A target already in flight waits (a second request of one
--   report is never sent beside the first).
-- app_render_slot_free(target) → boolean: the renderer answered (lambda-
--   worker.ts, on its render-results message, whatever the answer), or the
--   send failed: the slot is free at once.
CREATE TABLE render_slot (
	target      text PRIMARY KEY CHECK (target ~ '^(report|pack|applicant_pack):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	-- The waiting line's order: first asked, first sent.
	seq         bigint GENERATED ALWAYS AS IDENTITY,
	state       text NOT NULL CHECK (state IN ('waiting', 'sent')),
	asked_at    timestamptz NOT NULL DEFAULT now(),
	sent_at     timestamptz,
	expires_at  timestamptz NOT NULL
);
CREATE INDEX render_slot_line_idx ON render_slot (state, seq);
ALTER TABLE render_slot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON render_slot FROM PUBLIC, water_app;
COMMENT ON TABLE render_slot IS
	'Render requests in flight to the renderer Lambda, and those waiting for a slot (353). No grants: only app_render_slot_take / app_render_slot_free, from the worker''s context.';

CREATE FUNCTION app_render_slot_take(p_target text, p_limit integer) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_ttl constant interval := interval '10 minutes';
		v_state text;
		v_seq bigint;
		v_busy integer;
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
		DELETE FROM render_slot WHERE expires_at <= now();
		INSERT INTO render_slot (target, state, expires_at) VALUES (p_target, 'waiting', now() + v_ttl)
			ON CONFLICT (target) DO UPDATE SET
				-- A waiter's ask keeps its place in line; an in-flight slot keeps its own expiry.
				expires_at = CASE WHEN render_slot.state = 'waiting' THEN now() + v_ttl ELSE render_slot.expires_at END
			RETURNING state, seq INTO v_state, v_seq;
		IF v_state = 'sent' THEN
			RETURN false;
		END IF;
		SELECT count(*) INTO v_busy FROM render_slot
			WHERE state = 'sent' OR (state = 'waiting' AND seq < v_seq);
		IF v_busy >= p_limit THEN
			RETURN false;
		END IF;
		UPDATE render_slot SET state = 'sent', sent_at = now(), expires_at = now() + v_ttl WHERE target = p_target;
		RETURN true;
	END
	$$;

CREATE FUNCTION app_render_slot_free(p_target text) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_n integer;
	BEGIN
		IF app_current_user_id() IS NOT NULL THEN
			RAISE EXCEPTION 'render slots are the worker''s' USING ERRCODE = 'insufficient_privilege';
		END IF;
		DELETE FROM render_slot WHERE target = p_target AND state = 'sent';
		GET DIAGNOSTICS v_n = ROW_COUNT;
		RETURN v_n > 0;
	END
	$$;

REVOKE ALL ON FUNCTION app_render_slot_take(text, integer), app_render_slot_free(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_render_slot_take(text, integer), app_render_slot_free(text) TO water_app;

-- A report's answer window counts from when its request was sent, not from
-- when it was asked for: a report that waited for a slot hasn't been with
-- the renderer meanwhile (reports/store.ts reportState).
ALTER TABLE report ADD COLUMN sent_at timestamptz;
GRANT UPDATE (sent_at) ON report TO water_app;
