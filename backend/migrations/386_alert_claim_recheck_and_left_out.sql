-- 386_alert_claim_recheck_and_left_out — the mode re-check reads only what
-- may have changed, and the digest says how many whole catchments its limit
-- left out, counting only alerts the reader still gets (issues #883, #890;
-- docs/api.md § How alert mail is sent, docs/data-model.md § Alerts).
--
-- 1. app_alert_claim (latest: 370_alert_mode_at_send). 370 read the
--    audience (alert_audience) of every event with a waiting delivery on
--    every claim, digest backlog included, to find the deliveries whose
--    recipient's choice no longer matches their queue. A choice of
--    'daily_digest' only ever comes from an alert_subscription row (no
--    role's default is daily), so:
--      - a 'pending' delivery can only move if the recipient's own row for
--        that kind (the farm's row first, then the kind's) now says
--        'daily_digest';
--      - a 'digest' line (not put there by the cap) can only move if that
--        row now says 'immediate', or there is none (the default may be).
--    Those two tests read alert_subscription by its unique key per
--    delivery; only the deliveries that pass are checked against the full
--    audience, one read per distinct event among them, exactly as 370 did.
--    A backlog of daily lines from people who still choose daily (the usual
--    case) now costs index lookups, not an audience read each
--    (alerts/send.db.perf.test.ts holds the budget). The moves and everything
--    else are 370's.
--
-- 2. app_alert_claim_digest (latest: 371_alert_digest_fair_share).
--    a. Before the lines are ranked, each due line of the claimed people is
--       checked as the sender would check it: a line whose recipient no
--       longer gets the alert (no longer in its audience), turned it off, or
--       whose rule an editor switched off, is skipped now with the sender's
--       reason. So such a line neither takes one of the person's p_lines nor
--       counts in left_out: the counts a digest states are of alerts the
--       reader could still have read (#883). The sender still checks every
--       line it writes, under RLS, as before.
--    b. Past p_lines catchments (or fewer, with ties of turn), whole
--       catchments keep no line: the new column catchments_left_out is, on
--       every claimed line of a person, how many of their catchments this
--       claim left out entirely. Every digest that person gets says it (a
--       catchment's email is the only place to say it, and saying it in each
--       is what keeps it from being lost if one of them fails to send).
--    A new result column needs DROP and CREATE, as in 371; the first six
--    columns are unchanged. The lock (357), checks, parameters and grants
--    are 371's.
--
-- The race between the claim and the email being built (#890) is not
-- re-queued: the window is that one tick's send loop, the person gets the
-- choice they had moments before, and sending it back to 'digest' would
-- need a 'sending' → 'digest' path that doesn't spend an attempt
-- (data-model.md § Alerts says so).
--
-- alert_delivery.mode keeps its name (renaming a column the data export and
-- the policies read is an expand/contract for no gain); its comment now
-- says what it is.

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
		-- recipient's choice now says. Only the deliveries whose own
		-- subscription row could say so (386) get an audience read, one per event.
		WITH maybe AS MATERIALIZED (
			SELECT a.event_id, a.user_id, e.project_id, e.kind, e.node_id
			FROM alert_delivery a
			JOIN alert_event e ON e.id = a.event_id
			LEFT JOIN alert_subscription sn ON e.node_id IS NOT NULL AND sn.user_id = a.user_id AND sn.project_id = e.project_id
				AND sn.kind = e.kind AND sn.node_id = e.node_id
			LEFT JOIN alert_subscription sk ON sk.user_id = a.user_id AND sk.project_id = e.project_id AND sk.kind = e.kind AND sk.node_id IS NULL
			WHERE (a.status = 'pending' AND coalesce(sn.mode, sk.mode) = 'daily_digest')
			   OR (a.status = 'digest' AND a.reason IS DISTINCT FROM 'over the daily cap'
				AND (coalesce(sn.mode, sk.mode) IS NULL OR coalesce(sn.mode, sk.mode) = 'immediate'))
		), keys AS MATERIALIZED (
			SELECT DISTINCT m.event_id, m.project_id, m.kind, m.node_id FROM maybe m
		), aud AS MATERIALIZED (
			SELECT k.event_id, au.user_id, au.mode
			FROM keys k CROSS JOIN LATERAL alert_audience(k.project_id, k.kind, k.node_id) au
		), moved AS (
			SELECT a.event_id, a.user_id
			FROM alert_delivery a
			JOIN maybe m ON m.event_id = a.event_id AND m.user_id = a.user_id
			JOIN aud au ON au.event_id = a.event_id AND au.user_id = a.user_id
			WHERE (a.status = 'pending' AND au.mode = 'daily_digest')
			   OR (a.status = 'digest' AND au.mode = 'immediate' AND a.reason IS DISTINCT FROM 'over the daily cap')
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

DROP FUNCTION app_alert_claim_digest(timestamptz, integer, integer, interval);

CREATE FUNCTION app_alert_claim_digest(p_now timestamptz, p_people integer, p_lines integer, p_lease interval)
	RETURNS TABLE (event_id uuid, user_id uuid, project_id uuid, kind text, node_id uuid, left_out integer, catchments_left_out integer)
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
		v_out_whole boolean[];
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
		-- Due lines the reader no longer gets (386): skipped now, with the
		-- sender's reasons (alerts/send.ts), so they take no place in the
		-- limit and no part in what the digest says it left out.
		WITH due AS MATERIALIZED (
			SELECT d.event_id, d.user_id, e.project_id, e.kind, e.node_id, coalesce(r.enabled, false) AS enabled
			FROM alert_delivery d
			JOIN unnest(v_projects, v_since) b(id, since) ON b.id = d.project_id
			JOIN alert_event e ON e.id = d.event_id
			LEFT JOIN alert_rule r ON r.id = e.rule_id
			WHERE d.status = 'digest' AND d.created_at < b.since AND d.user_id = ANY (v_people)
		), keys AS MATERIALIZED (
			SELECT DISTINCT du.project_id, du.kind, du.node_id FROM due du
		), aud AS MATERIALIZED (
			SELECT k.project_id, k.kind, k.node_id, au.user_id, au.mode
			FROM keys k CROSS JOIN LATERAL alert_audience(k.project_id, k.kind, k.node_id) au
			WHERE au.user_id = ANY (v_people)
		), gone AS (
			SELECT du.event_id, du.user_id,
				CASE WHEN NOT du.enabled THEN 'the catchment switched this alert off'
					WHEN au.mode IS NULL THEN 'no longer gets this alert'
					ELSE 'turned this alert off' END AS why
			FROM due du
			LEFT JOIN aud au ON au.project_id = du.project_id AND au.kind = du.kind
				AND au.node_id IS NOT DISTINCT FROM du.node_id AND au.user_id = du.user_id
			WHERE NOT du.enabled OR au.mode IS NULL OR au.mode = 'off'
		)
		UPDATE alert_delivery a SET status = 'skipped', via = 'digest', locked_until = NULL, reason = gone.why
		FROM gone WHERE a.event_id = gone.event_id AND a.user_id = gone.user_id AND a.status = 'digest';
		-- Due lines past each person's first p_lines, ranked by turns across
		-- their catchments (371): handled, never sent, and counted below,
		-- per catchment and, for a catchment that kept none, as a whole (386).
		WITH ranked AS (
			SELECT t.event_id, t.user_id, t.project_id,
				row_number() OVER (PARTITION BY t.user_id ORDER BY t.turn, t.created_at DESC, t.event_id) AS rn
			FROM (
				SELECT d.event_id, d.user_id, d.project_id, d.created_at,
					row_number() OVER (PARTITION BY d.user_id, d.project_id ORDER BY d.created_at DESC, d.event_id) AS turn
				FROM alert_delivery d JOIN unnest(v_projects, v_since) b(id, since) ON b.id = d.project_id
				WHERE d.status = 'digest' AND d.created_at < b.since AND d.user_id = ANY (v_people)
			) t
		), kept AS (
			SELECT DISTINCT r.user_id, r.project_id FROM ranked r WHERE r.rn <= p_lines
		), skipped AS (
			UPDATE alert_delivery a SET status = 'skipped', via = 'digest', locked_until = NULL, reason = 'over the digest limit'
			FROM ranked r
			WHERE a.event_id = r.event_id AND a.user_id = r.user_id AND r.rn > p_lines AND a.status = 'digest'
			RETURNING a.user_id, a.project_id
		)
		SELECT array_agg(g.user_id), array_agg(g.project_id), array_agg(g.n), array_agg(k.user_id IS NULL)
			INTO v_out_people, v_out_projects, v_out_n, v_out_whole
		FROM (SELECT s.user_id, s.project_id, count(*)::int AS n FROM skipped s GROUP BY s.user_id, s.project_id) g
		LEFT JOIN kept k ON k.user_id = g.user_id AND k.project_id = g.project_id;
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
		), lo AS (
			SELECT * FROM unnest(v_out_people, v_out_projects, v_out_n, v_out_whole) l(user_id, project_id, n, whole)
		), wc AS (
			SELECT o.user_id, count(*)::int AS n FROM lo o WHERE o.whole GROUP BY o.user_id
		)
		SELECT c.event_id, c.user_id, e.project_id, e.kind, e.node_id, coalesce(l.n, 0), coalesce(w.n, 0)
		FROM claimed c JOIN alert_event e ON e.id = c.event_id
		LEFT JOIN lo l ON l.user_id = c.user_id AND l.project_id = e.project_id
		LEFT JOIN wc w ON w.user_id = c.user_id
		ORDER BY c.user_id, c.created_at DESC, c.event_id;
	END
	$$;

REVOKE ALL ON FUNCTION app_alert_claim_digest(timestamptz, integer, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_alert_claim_digest(timestamptz, integer, integer, interval) TO water_app;

COMMENT ON COLUMN alert_delivery.mode IS
	'The recipient''s choice when the alert was queued (fan-out). Since 370 the choice at send time wins, so this is not how it went out: via is.';
