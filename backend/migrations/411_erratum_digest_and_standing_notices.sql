-- 411_erratum_digest_and_standing_notices — two email surprises an
-- existing-user review of the release found (docs/legal/known-defect-procedure.md,
-- docs/architecture.md § Alerts).
--
-- 1. One errata email per owner and catchment, not one per erratum.
--    The release adds several errata at once. app_erratum_notice_claim (153)
--    claimed notices one row at a time, so the tick mailed an owner once per
--    erratum per catchment: five errata, three catchments, fifteen emails.
--    errata/notices.ts now sends one email per owner and project listing
--    every erratum it claimed for them, and this claim hands it whole groups:
--    p_limit is now how many (project, owner) groups, and every pending
--    notice of each claimed group comes with it. Each notice keeps its row
--    (one per erratum, project and owner, ever: the primary key), its lease,
--    its attempts and its own outcome (app_erratum_notice_finish, unchanged),
--    so a later sweep never re-sends an erratum already told, and a retry
--    re-sends only what wasn't. Same signature and columns, from 153's (the
--    latest; 289 and 313 changed only the sweep). A notice another worker
--    holds is skipped (SKIP LOCKED), as before: two overlapping ticks could
--    still split a group, never send a notice twice.
--
-- 2. A standing farm-view notice is not news.
--    Since this release (alerts/evaluate.ts), words published under
--    restriction level 'none' open a restriction_published event and are
--    mailed; before, a rule that had never fired skipped a 'none'
--    publication altogether. So every project whose current publication is
--    'none' with words, and whose restriction_published rule has no event
--    yet, would email every subscriber its old notice, with its old publish
--    date, within an hour of deploy. app_alert_silence_standing_notices
--    records, for each such rule, the event evaluate.ts would have opened
--    (cleared, the same detail and signature), without app_alert_fan_out:
--    nothing is queued, and the next check sees the signature as already
--    announced. Only words published after the deploy are mailed. The
--    migration calls it once; it stays for the DB test
--    (alerts/alerts.db.test.ts, "a notice standing at the deploy") and is the owner's only (revoked
--    from water_app, which writes events as an editor through evaluate.ts).
--    Idempotent: a rule with any event is left alone.
--
-- Forward-only; nothing is dropped.

-- ---------------------------------------------------------------------------
-- 1. The claim, by (project, owner) group
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_erratum_notice_claim(p_limit integer, p_lease interval)
	RETURNS TABLE (erratum_id text, project_id uuid, user_id uuid, run_count integer)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends erratum notices' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim 1–500 notices with a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE erratum_notice n SET status = 'failed', locked_until = NULL, settled_at = now(), reason = 'the worker stopped while sending'
		WHERE n.status = 'sending' AND n.locked_until < now();
		RETURN QUERY
			WITH groups AS (
				-- The oldest p_limit (project, owner) pairs with a notice to send: one email each.
				SELECT n.project_id, n.user_id FROM erratum_notice n
				WHERE n.status = 'pending'
				GROUP BY n.project_id, n.user_id
				ORDER BY min(n.created_at), n.project_id, n.user_id
				LIMIT p_limit
			), due AS (
				SELECT n.erratum_id, n.project_id, n.user_id FROM erratum_notice n
				JOIN groups g ON g.project_id = n.project_id AND g.user_id = n.user_id
				WHERE n.status = 'pending'
				FOR UPDATE OF n SKIP LOCKED
			), claimed AS (
				UPDATE erratum_notice n SET status = 'sending', claimed_at = now(), locked_until = now() + p_lease, attempts = n.attempts + 1
				FROM due d WHERE n.erratum_id = d.erratum_id AND n.project_id = d.project_id AND n.user_id = d.user_id
				RETURNING n.erratum_id, n.project_id, n.user_id, n.run_count
			)
			SELECT c.erratum_id, c.project_id, c.user_id, c.run_count FROM claimed c
			ORDER BY c.project_id, c.user_id, substring(c.erratum_id FROM 4)::integer;
	END
	$$;

-- ---------------------------------------------------------------------------
-- 2. Standing 'none' notices, recorded as announced
-- ---------------------------------------------------------------------------
-- The detail is evaluate.ts's for a first event under 'none': the signature
-- is `none||<code>:<md5 of the words>,…` (codes in code-point order, pct
-- empty since 'none' has none, 022), lifted false (no earlier event), and
-- publishedAt as JavaScript's toISOString writes it. alert_event_guard (312)
-- fills kind, node, opened_at, cleared_at and threshold.
CREATE FUNCTION app_alert_silence_standing_notices() RETURNS integer
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		INSERT INTO alert_event (rule_id, project_id, state, value, detail, run_id)
			SELECT r.id, r.project_id, 'cleared', NULL,
				jsonb_build_object(
					'publicationId', p.id,
					'level', 'none',
					'pct', NULL,
					'lifted', false,
					'signature', 'none||' || w.words,
					'publishedAt', to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
				),
				p.run_id
			FROM alert_rule r
			JOIN run_publication p ON p.project_id = r.project_id AND p.superseded_at IS NULL
			CROSS JOIN LATERAL (
				SELECT string_agg(k || ':' || md5(p.notice ->> k), ',' ORDER BY k COLLATE "C") AS words FROM jsonb_object_keys(p.notice) k
			) w
			WHERE r.kind = 'restriction_published'
				AND p.restriction_level = 'none'
				AND w.words IS NOT NULL
				AND NOT EXISTS (SELECT 1 FROM alert_event e WHERE e.rule_id = r.id);
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;

REVOKE ALL ON FUNCTION app_alert_silence_standing_notices() FROM PUBLIC, water_app;

SELECT app_alert_silence_standing_notices();
