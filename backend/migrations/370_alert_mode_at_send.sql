-- 370_alert_mode_at_send — the person's mode when the alert is sent wins,
-- not the one they had when it was queued (issue #868; docs/api.md § How
-- alert mail is sent, docs/data-model.md § Alerts).
--
-- app_alert_fan_out queues each delivery as 'pending' (to send now) or
-- 'digest' by the recipient's choice at that moment (alert_delivery.mode).
-- Someone who switched from "right away" to "once a day" before the next
-- tick still got that alert as its own email, and someone who switched the
-- other way waited for the next 06:00 digest. The sender re-checked access
-- and "off" (app_alert_my_mode, send.ts) but not right away against daily.
--
-- app_alert_claim (latest: 059_local_day, unchanged since) now first moves
-- each open delivery to the queue its recipient's current mode
-- (alert_audience, 141) says:
--   - 'pending' whose recipient now chooses daily_digest → 'digest', reason
--     cleared, so it goes in the next digest after 06:00 in the project's
--     zone, like any line queued as daily;
--   - 'digest' whose recipient now chooses immediate → 'pending', claimed in
--     the same call (under the daily cap as ever), so it goes out at this
--     tick. A line put in the digest *by the cap* (reason 'over the daily
--     cap') stays there: that was the cap's doing, not the person's choice,
--     and moving it back would only have the cap put it back.
-- A recipient with no mode (no longer in the audience) or 'off' is left as
-- it is: the sender skips it when it builds the mail, as before. The rows are
-- found without a lock, then locked SKIP LOCKED, so a row another worker is
-- claiming right now is left to it (the next tick sees it again) and two
-- workers never wait on each other's rows.
--
-- Same signature, checks, cap, lease, locks, result and grants as 059's;
-- only the move is new. CREATE OR REPLACE keeps the grants; restated below.

CREATE OR REPLACE FUNCTION app_alert_claim(p_limit integer, p_now timestamptz, p_cap integer, p_lease interval)
	RETURNS TABLE (event_id uuid, user_id uuid, project_id uuid, kind text, node_id uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		d record;
		sent integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends alerts' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR p_cap IS NULL OR p_cap < 0 OR p_now IS NULL
			OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim 1–500 deliveries, a cap ≥ 0 and a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE alert_delivery a SET status = 'failed', locked_until = NULL, reason = 'the worker stopped while sending'
		WHERE a.status = 'sending' AND a.locked_until < now();
		-- The mode at send time wins (370): each open delivery to the queue its
		-- recipient's choice now says. One audience read per event.
		WITH keys AS (
			SELECT DISTINCT e.id, e.project_id, e.kind, e.node_id
			FROM alert_delivery a JOIN alert_event e ON e.id = a.event_id
			WHERE a.status IN ('pending', 'digest')
		), moved AS (
			SELECT a.event_id, a.user_id
			FROM alert_delivery a
			JOIN keys k ON k.id = a.event_id
			CROSS JOIN LATERAL alert_audience(k.project_id, k.kind, k.node_id) au
			WHERE au.user_id = a.user_id
			  AND ((a.status = 'pending' AND au.mode = 'daily_digest')
			    OR (a.status = 'digest' AND au.mode = 'immediate' AND a.reason IS DISTINCT FROM 'over the daily cap'))
			FOR UPDATE OF a SKIP LOCKED
		)
		UPDATE alert_delivery a SET status = CASE a.status WHEN 'pending' THEN 'digest' ELSE 'pending' END, reason = NULL
		FROM moved WHERE a.event_id = moved.event_id AND a.user_id = moved.user_id;
		FOR d IN
			SELECT a.event_id, a.user_id, alert_digest_start(p_now, p.time_zone) AS since
			FROM alert_delivery a JOIN project p ON p.id = a.project_id
			WHERE a.status = 'pending'
			ORDER BY a.created_at, a.event_id
			LIMIT p_limit
			FOR UPDATE OF a SKIP LOCKED
		LOOP
			PERFORM pg_advisory_xact_lock(hashtextextended('alert_cap:' || d.user_id::text, 0));
			SELECT count(*) INTO sent FROM alert_delivery a
			WHERE a.user_id = d.user_id AND a.via = 'immediate' AND a.status IN ('sending', 'sent') AND a.claimed_at >= d.since;
			IF sent >= p_cap THEN
				UPDATE alert_delivery a SET status = 'digest', reason = 'over the daily cap'
				WHERE a.event_id = d.event_id AND a.user_id = d.user_id;
			ELSE
				UPDATE alert_delivery a SET status = 'sending', via = 'immediate', claimed_at = now(),
					locked_until = now() + p_lease, attempts = a.attempts + 1
				WHERE a.event_id = d.event_id AND a.user_id = d.user_id;
				RETURN QUERY
					SELECT e.id, d.user_id, e.project_id, e.kind, e.node_id FROM alert_event e WHERE e.id = d.event_id;
			END IF;
		END LOOP;
	END
	$$;

REVOKE ALL ON FUNCTION app_alert_claim(integer, timestamptz, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_alert_claim(integer, timestamptz, integer, interval) TO water_app;
