-- 371_alert_digest_fair_share — the digest's per-person line limit never
-- drops a catchment for a busier one, and says what it left out (issue #869;
-- docs/data-model.md § Alerts, docs/api.md § Alerts).
--
-- app_alert_claim_digest (357, from 059's) kept each person's newest p_lines
-- due digest lines across all their catchments and skipped the rest as 'over
-- the digest limit'. One busy catchment could take the whole limit: a
-- quieter one's lines were all skipped, and that catchment's digest never
-- came, with nothing in any email to say so.
--
-- The limit stays per person (it keeps the inbox to a bounded size), but the
-- lines are now ranked by turns: each catchment's newest line first, then
-- each one's second newest, and so on (newest first within a turn). The first
-- p_lines of that order are kept, so every catchment with due lines keeps at
-- least one while the person has no more than p_lines of them, and a quiet
-- catchment keeps all its lines before a busy one fills the rest.
--
-- The result gains left_out: on each claimed line, how many of that person's
-- lines of that catchment this claim skipped as over the limit (the same
-- number on every line of the person and catchment). The digest email says
-- it. A new result column needs DROP and CREATE (CREATE OR REPLACE can't
-- change a result type); the old five columns are unchanged, so a worker
-- still running the previous code (which names them) keeps working.
--
-- The lock (357), checks, parameters and grants are 357's.

DROP FUNCTION app_alert_claim_digest(timestamptz, integer, integer, interval);

CREATE FUNCTION app_alert_claim_digest(p_now timestamptz, p_people integer, p_lines integer, p_lease interval)
	RETURNS TABLE (event_id uuid, user_id uuid, project_id uuid, kind text, node_id uuid, left_out integer)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		v_people uuid[];
		v_projects uuid[];
		v_since timestamptz[];
		v_out_people uuid[];
		v_out_projects uuid[];
		v_out_n integer[];
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
		-- Due lines past each person's first p_lines, ranked by turns across
		-- their catchments (371): handled, never sent, and counted below.
		WITH ranked AS (
			SELECT t.event_id, t.user_id,
				row_number() OVER (PARTITION BY t.user_id ORDER BY t.turn, t.created_at DESC, t.event_id) AS rn
			FROM (
				SELECT d.event_id, d.user_id, d.created_at,
					row_number() OVER (PARTITION BY d.user_id, d.project_id ORDER BY d.created_at DESC, d.event_id) AS turn
				FROM alert_delivery d JOIN unnest(v_projects, v_since) b(id, since) ON b.id = d.project_id
				WHERE d.status = 'digest' AND d.created_at < b.since AND d.user_id = ANY (v_people)
			) t
		), skipped AS (
			UPDATE alert_delivery a SET status = 'skipped', via = 'digest', locked_until = NULL, reason = 'over the digest limit'
			FROM ranked r
			WHERE a.event_id = r.event_id AND a.user_id = r.user_id AND r.rn > p_lines AND a.status = 'digest'
			RETURNING a.user_id, a.project_id
		)
		SELECT array_agg(g.user_id), array_agg(g.project_id), array_agg(g.n) INTO v_out_people, v_out_projects, v_out_n
		FROM (SELECT s.user_id, s.project_id, count(*)::int AS n FROM skipped s GROUP BY s.user_id, s.project_id) g;
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
		SELECT c.event_id, c.user_id, e.project_id, e.kind, e.node_id, coalesce(l.n, 0)
		FROM claimed c JOIN alert_event e ON e.id = c.event_id
		LEFT JOIN unnest(v_out_people, v_out_projects, v_out_n) l(user_id, project_id, n) ON l.user_id = c.user_id AND l.project_id = e.project_id
		ORDER BY c.user_id, c.created_at DESC, c.event_id;
	END
	$$;

REVOKE ALL ON FUNCTION app_alert_claim_digest(timestamptz, integer, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_alert_claim_digest(timestamptz, integer, integer, interval) TO water_app;
