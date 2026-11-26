-- 363_station_feed_fairness — a project's share of the station queue is
-- bounded (issue #784 follow-up; docs/security.md § The fetcher's capacity).
--
-- Station API feeds' fetches have their own FIFO queue and at most 2 fetcher
-- executions at once, shared by every project (infra/feeds.tf, "Station
-- fetches apart"). Before: every station feed of a project that came due went
-- straight onto that queue, so a project with many feeds on slow hosts (each
-- fetch up to 2 minutes) put up to its 10 feeds' fetches
-- (MAX_STATION_FEEDS), plus its Run now presses, ahead of another project's
-- one feed.
--
-- Now a station feed_fetch job sends only while its project has fewer than
-- p_cap other station fetches out (the worker passes
-- STATION_FETCHES_PER_PROJECT, 2): app_begin_station_fetch counts them and
-- records this fetch (app_begin_feed_fetch, 029) in one transaction under a
-- per-project advisory lock, so two workers can't both take the last place.
-- Without a place it records nothing and returns false, and the job goes back
-- to the job table, its attempt given back (JobRelease), and asks again
-- later. So the station queue holds at most p_cap fetches of any one project
-- at a time, and another project's feed is never queued behind more than
-- p_cap of each other project's.
--
-- "Out" is the feed's own record of its fetch (data_feed.fetch_job_id, 029)
-- as app_feed_fetch_out (276) reads it: set when the request is sent,
-- cleared when its answer is applied, and no longer counted a day after the
-- fetch job last started (an answer lost for good), so a lost answer can't
-- hold a project's place for longer. The feed's own earlier fetch isn't
-- counted (a Run now press superseding it takes no second place).
--
-- No table, column or policy changes; app_begin_feed_fetch is called, not
-- changed. SECURITY DEFINER, as app_begin_feed_fetch: it reads the
-- project's other feeds and their jobs as the owner, after the same check
-- (an editor running that feed's feed_fetch job as its acting user), so it
-- tells a caller nothing about a project it can't already see.

CREATE FUNCTION app_begin_station_fetch(p_feed uuid, p_job uuid, p_start date, p_end date, p_cap integer)
	RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_project uuid;
		v_out integer;
	BEGIN
		SELECT f.project_id INTO v_project FROM data_feed f WHERE f.id = p_feed AND f.source = 'station_api';
		IF v_project IS NULL OR NOT app_has_role(v_project, 'editor') OR NOT EXISTS (
			SELECT 1 FROM job j
			WHERE j.id = p_job AND j.project_id = v_project AND j.kind = 'feed_fetch' AND j.status = 'running'
			  AND j.payload ->> 'feedId' = p_feed::text AND j.acting_user_id = app_current_user_id()
		) THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_cap IS NULL OR p_cap < 1 OR p_cap > 10 THEN
			RAISE EXCEPTION 'a cap of 1–10 station fetches' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		-- One begin at a time per project, to the end of this transaction: the
		-- count and the record are seen together by the next.
		PERFORM pg_advisory_xact_lock(hashtextextended('station_fetch:' || v_project::text, 0));
		SELECT count(*) INTO v_out FROM data_feed f
		WHERE f.project_id = v_project AND f.source = 'station_api' AND f.id <> p_feed
		  AND app_feed_fetch_out(f.fetch_job_id, now());
		IF v_out >= p_cap THEN
			RETURN false;
		END IF;
		PERFORM app_begin_feed_fetch(p_feed, p_job, p_start, p_end);
		RETURN true;
	END
	$$;

REVOKE ALL ON FUNCTION app_begin_station_fetch(uuid, uuid, date, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_begin_station_fetch(uuid, uuid, date, date, integer) TO water_app;
COMMENT ON FUNCTION app_begin_station_fetch(uuid, uuid, date, date, integer) IS
	'Record a station API feed''s fetch (app_begin_feed_fetch) only while its project has fewer than p_cap other station fetches out; false (nothing recorded) otherwise (363).';
