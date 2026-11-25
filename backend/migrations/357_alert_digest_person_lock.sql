-- 357_alert_digest_person_lock — one digest per person, even with two workers
-- claiming at once (docs/data-model.md § Alerts, docs/architecture.md § Alerts).
--
-- app_alert_claim_digest (059_local_day, unchanged since) picked the people
-- whose digest lines are due, then claimed their lines `FOR UPDATE SKIP
-- LOCKED`. Two workers claiming at the same moment could both pick the same
-- person and each lock part of that person's lines as their scans
-- interleaved: the one person got two digest emails, each with some of the
-- lines, and the newest-`p_lines` limit was worked out on each half.
--
-- Now each picked person is claimed under a transaction-scoped advisory lock
-- on that person ('alert_digest:' || user_id), as app_alert_claim takes
-- 'alert_cap:' || user_id per person. It's a *try* lock: a person another
-- worker is claiming right now is left to that worker, not waited for, so
-- two workers never block each other (the SKIP LOCKED idea, per person
-- rather than per line). The lock is taken before any line is read or
-- marked, and every later statement reads afresh (READ COMMITTED), so a
-- worker that gets the lock after another committed finds that person's
-- lines already 'sending' and claims none of them.
--
-- Same parameters, checks, result and grants as 059's; only the lock is new.
-- CREATE OR REPLACE keeps the grants; they're restated below all the same.

CREATE OR REPLACE FUNCTION app_alert_claim_digest(p_now timestamptz, p_people integer, p_lines integer, p_lease interval)
	RETURNS TABLE (event_id uuid, user_id uuid, project_id uuid, kind text, node_id uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		v_people uuid[];
		v_projects uuid[];
		v_since timestamptz[];
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends alerts' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_now IS NULL OR p_people IS NULL OR p_people < 1 OR p_people > 500 OR p_lines IS NULL OR p_lines < 1 OR p_lines > 1000
			OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim digests for 1–500 people, 1–1000 lines each, with a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		-- Each waiting project's digest day, worked out once.
		SELECT array_agg(p.id), array_agg(alert_digest_start(p_now, p.time_zone)) INTO v_projects, v_since
		FROM project p WHERE p.id IN (SELECT DISTINCT x.project_id FROM alert_delivery x WHERE x.status = 'digest');
		IF v_projects IS NULL THEN
			RETURN;
		END IF;
		SELECT array_agg(x.user_id) INTO v_people FROM (
			SELECT DISTINCT a.user_id FROM alert_delivery a JOIN unnest(v_projects, v_since) b(id, since) ON b.id = a.project_id
			WHERE a.status = 'digest' AND a.created_at < b.since
			LIMIT p_people
		) x;
		IF v_people IS NULL THEN
			RETURN;
		END IF;
		-- Only the people no other worker is claiming right now (357): each
		-- person's lines go to one worker, so into one digest.
		SELECT array_agg(u) INTO v_people FROM unnest(v_people) u
		WHERE pg_try_advisory_xact_lock(hashtextextended('alert_digest:' || u::text, 0));
		IF v_people IS NULL THEN
			RETURN;
		END IF;
		-- Due lines past each person's newest p_lines: handled, never sent.
		UPDATE alert_delivery a SET status = 'skipped', via = 'digest', locked_until = NULL, reason = 'over the digest limit'
		FROM (
			SELECT d.event_id, d.user_id, row_number() OVER (PARTITION BY d.user_id ORDER BY d.created_at DESC, d.event_id) AS rn
			FROM alert_delivery d JOIN unnest(v_projects, v_since) b(id, since) ON b.id = d.project_id
			WHERE d.status = 'digest' AND d.created_at < b.since AND d.user_id = ANY (v_people)
		) r
		WHERE a.event_id = r.event_id AND a.user_id = r.user_id AND r.rn > p_lines AND a.status = 'digest';
		RETURN QUERY
		WITH due AS (
			SELECT a.event_id, a.user_id FROM alert_delivery a JOIN unnest(v_projects, v_since) b(id, since) ON b.id = a.project_id
			WHERE a.status = 'digest' AND a.created_at < b.since AND a.user_id = ANY (v_people)
			FOR UPDATE OF a SKIP LOCKED
		), claimed AS (
			UPDATE alert_delivery a SET status = 'sending', via = 'digest', claimed_at = now(),
				locked_until = now() + p_lease, attempts = a.attempts + 1
			FROM due WHERE a.event_id = due.event_id AND a.user_id = due.user_id
			RETURNING a.event_id, a.user_id, a.created_at
		)
		SELECT c.event_id, c.user_id, e.project_id, e.kind, e.node_id
		FROM claimed c JOIN alert_event e ON e.id = c.event_id
		ORDER BY c.user_id, c.created_at DESC, c.event_id;
	END
	$$;

REVOKE ALL ON FUNCTION app_alert_claim_digest(timestamptz, integer, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_alert_claim_digest(timestamptz, integer, integer, interval) TO water_app;
