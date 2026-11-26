-- 394_job_dead_reason — why a job died, in its own column (issue #904;
-- docs/data-model.md § Jobs, docs/architecture.md § Background jobs).
--
-- A dead job is one of three things: someone cancelled it, a newer job with
-- its dedupe key replaced it (superseded), or it failed (a dead letter: the
-- production alarm and the owners' job_dead alert). The runner and the alert
-- told them apart by matching our own stored error text ('cancelled', the
-- ' (a newer job with the same key is queued)' suffix). `job.dead_reason`
-- says it instead: set by every path that kills a job, NULL while it lives.
--
-- Also: a running job someone cancelled that hands itself back
-- (app_release_job) or fails with a retry (app_finish_job) went back to the
-- queue still flagged, and stopped only at its next progress report, redoing
-- some work first. Both now end it, dead as cancelled. So does a claim that
-- finds a cancelled job whose worker died (app_claim_jobs), which ran it
-- again only for it to stop.
--
-- Expand only: app_finish_job keeps its signature for a backend still
-- running while this lands, as a wrapper over the new app_finish_job_outcome,
-- which takes the reason and says it back; the wrapper infers the reason from
-- the text that backend writes. Rows dead before this migration get theirs
-- from the same text, once, here.
--
-- No policy or grant changes on the table (water_app reads job as before,
-- and still updates nothing directly); no personal data.

ALTER TABLE job ADD COLUMN dead_reason text;

-- Rows already dead: their reason from the text the runner and the cancel wrote (jobs/errors.ts JOB_CANCELLED,
-- SUPERSEDED_NOTE); anything else died of its own failure.
UPDATE job SET dead_reason = CASE
		WHEN last_error = 'cancelled' THEN 'cancelled'
		WHEN right(COALESCE(last_error, ''), 42) = ' (a newer job with the same key is queued)' THEN 'superseded'
		ELSE 'failed'
	END
WHERE status = 'dead';

ALTER TABLE job ADD CONSTRAINT job_dead_reason_check
	CHECK (dead_reason IN ('cancelled', 'superseded', 'failed') AND status = 'dead' OR dead_reason IS NULL AND status <> 'dead');

COMMENT ON COLUMN job.dead_reason IS
	'Why a dead job died: cancelled (someone cancelled it), superseded (a newer job with its dedupe key does the work) or failed (a dead letter: the alarm and the job_dead alert). NULL unless status is dead (394_job_dead_reason).';

-- A safety net under the CHECK: a job that leaves `dead` (none does today) loses its reason, an insert can't forge
-- one, and a path that kills a job without saying why records `failed`, so it alarms rather than being lost. Named to
-- sort after job_enqueue, so on an insert it sees the status that trigger forced.
CREATE FUNCTION job_settle_dead_reason() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.status IS DISTINCT FROM 'dead' THEN
			NEW.dead_reason := NULL;
		ELSIF NEW.dead_reason IS NULL THEN
			NEW.dead_reason := 'failed';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER job_settle_dead_reason BEFORE INSERT OR UPDATE ON job
	FOR EACH ROW EXECUTE FUNCTION job_settle_dead_reason();

-- Record a claimed job's outcome, saying why when it dies (016 app_finish_job's work, plus the reason and the
-- cancel). p_dead_reason is the caller's word for a death: 'cancelled' (the handler stopped because it was
-- cancelled), 'superseded', or NULL / 'failed'. A failure with a retry left becomes `failed` (back to the queue
-- after its backoff), unless someone cancelled the job while it ran: then it is dead as cancelled, its error
-- 'cancelled'. A failure with no retry keeps the caller's reason (a real error stays a dead letter even when a cancel
-- arrived meanwhile). Returns the new status and reason; both NULL when the lease was lost.
CREATE FUNCTION app_finish_job_outcome(
	p_id uuid, p_lease uuid, p_ok boolean, p_error text, p_retry boolean, p_dead_reason text,
	OUT status text, OUT dead_reason text)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		v_attempts integer;
		v_max integer;
		v_cancelled boolean;
		v_error text;
	BEGIN
		IF p_dead_reason IS NOT NULL AND p_dead_reason NOT IN ('cancelled', 'superseded', 'failed') THEN
			RAISE EXCEPTION 'a job dies cancelled, superseded or failed' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		SELECT j.attempts, j.max_attempts, j.cancel_requested_at IS NOT NULL INTO v_attempts, v_max, v_cancelled
		FROM job j WHERE j.id = p_id AND j.status = 'running' AND j.lease_token = p_lease
		FOR UPDATE;
		IF NOT FOUND THEN
			RETURN;
		END IF;
		v_error := left(COALESCE(NULLIF(p_error, ''), 'failed'), 500);
		IF p_ok THEN
			status := 'done';
		ELSIF p_retry AND v_cancelled THEN
			status := 'dead';
			dead_reason := 'cancelled';
			v_error := 'cancelled';
		ELSIF p_retry AND v_attempts < v_max THEN
			status := 'failed';
		ELSE
			status := 'dead';
			dead_reason := COALESCE(p_dead_reason, 'failed');
		END IF;
		UPDATE job j SET
			status = app_finish_job_outcome.status,
			dead_reason = app_finish_job_outcome.dead_reason,
			run_after = CASE WHEN app_finish_job_outcome.status = 'failed'
				THEN now() + make_interval(mins => power(2, v_attempts)::integer) ELSE j.run_after END,
			last_error = CASE WHEN p_ok THEN NULL ELSE v_error END,
			finished_at = CASE WHEN app_finish_job_outcome.status IN ('done', 'dead') THEN now() END,
			locked_until = NULL,
			lease_token = NULL
		WHERE j.id = p_id;
	END
	$$;

COMMENT ON FUNCTION app_finish_job_outcome(uuid, uuid, boolean, text, boolean, text) IS
	'Record a claimed job''s outcome (the worker''s context): new status and, when dead, why (cancelled, superseded, failed); a cancelled job is never retried. NULLs when the lease was lost (394_job_dead_reason).';

REVOKE ALL ON FUNCTION app_finish_job_outcome(uuid, uuid, boolean, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finish_job_outcome(uuid, uuid, boolean, text, boolean, text) TO water_app;

-- Latest definition: 016_jobs.sql. Same signature, settings and grants; the work is app_finish_job_outcome's, the
-- reason inferred from the text a backend from before this migration writes (jobs/errors.ts JOB_CANCELLED,
-- SUPERSEDED_NOTE). The current backend calls app_finish_job_outcome.
CREATE OR REPLACE FUNCTION app_finish_job(p_id uuid, p_lease uuid, p_ok boolean, p_error text DEFAULT NULL, p_retry boolean DEFAULT true)
	RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN (SELECT o.status FROM app_finish_job_outcome(p_id, p_lease, p_ok, p_error, p_retry,
			CASE WHEN p_error = 'cancelled' THEN 'cancelled'
				WHEN right(COALESCE(p_error, ''), 42) = ' (a newer job with the same key is queued)' THEN 'superseded' END) o);
	END
	$$;

-- Latest definition: 191_delineation_request.sql. Same signature and grants. A job someone cancelled while it ran
-- isn't handed back: it is dead as cancelled, and 'dead' is returned ('queued' otherwise, NULL when the lease was lost).
CREATE OR REPLACE FUNCTION app_release_job(p_id uuid, p_lease uuid, p_delay_seconds integer) RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_status text;
	BEGIN
		IF p_delay_seconds IS NULL OR p_delay_seconds < 0 OR p_delay_seconds > 3600 THEN
			RAISE EXCEPTION 'a release waits 0 to 3600 s' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE job j SET
			status = CASE WHEN j.cancel_requested_at IS NULL THEN 'queued' ELSE 'dead' END,
			dead_reason = CASE WHEN j.cancel_requested_at IS NULL THEN NULL ELSE 'cancelled' END,
			last_error = CASE WHEN j.cancel_requested_at IS NULL THEN j.last_error ELSE 'cancelled' END,
			finished_at = CASE WHEN j.cancel_requested_at IS NULL THEN j.finished_at ELSE now() END,
			attempts = CASE WHEN j.cancel_requested_at IS NULL THEN greatest(j.attempts - 1, 0) ELSE j.attempts END,
			run_after = CASE WHEN j.cancel_requested_at IS NULL THEN now() + make_interval(secs => p_delay_seconds) ELSE j.run_after END,
			locked_until = NULL,
			lease_token = NULL
		WHERE j.id = p_id AND j.status = 'running' AND j.lease_token = p_lease
		RETURNING j.status INTO v_status;
		RETURN v_status;
	END
	$$;

-- Latest definition: 123_scoped_job_claim.sql. Same signature and grants. A running job whose lease ran out is dead
-- (and not claimed again) when it has no attempts left, as before (failed), or when someone cancelled it (cancelled).
CREATE OR REPLACE FUNCTION app_claim_jobs(p_limit integer, p_lease interval, p_projects uuid[] DEFAULT NULL)
	RETURNS TABLE (id uuid, project_id uuid, kind text, acting_user_id uuid, lease_token uuid, attempts integer, max_attempts integer)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim 1–100 jobs for a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE job j SET status = 'dead', finished_at = now(), locked_until = NULL, lease_token = NULL,
			dead_reason = CASE WHEN j.cancel_requested_at IS NULL THEN 'failed' ELSE 'cancelled' END,
			last_error = CASE WHEN j.cancel_requested_at IS NULL
				THEN 'the worker stopped before the job finished, and it has no attempts left' ELSE 'cancelled' END
		WHERE j.status = 'running' AND j.locked_until < now() AND (j.attempts >= j.max_attempts OR j.cancel_requested_at IS NOT NULL)
		  AND (p_projects IS NULL OR j.project_id = ANY (p_projects));
		RETURN QUERY
		WITH due AS (
			SELECT d.id FROM job d
			WHERE ((d.status IN ('queued', 'failed') AND d.run_after <= now())
				OR (d.status = 'running' AND d.locked_until < now()))
			  AND (p_projects IS NULL OR d.project_id = ANY (p_projects))
			  AND (d.dedupe_key IS NULL OR NOT EXISTS (
				SELECT 1 FROM job r
				WHERE r.project_id = d.project_id AND r.dedupe_key = d.dedupe_key AND r.status = 'running' AND r.id <> d.id))
			ORDER BY d.run_after, d.created_at
			LIMIT p_limit
			FOR UPDATE SKIP LOCKED
		), claimed AS (
			UPDATE job j SET status = 'running', attempts = j.attempts + 1, locked_until = now() + p_lease,
				lease_token = gen_random_uuid(), started_at = now()
			FROM due WHERE j.id = due.id
			RETURNING j.id, j.project_id, j.kind, j.acting_user_id, j.lease_token, j.attempts, j.max_attempts
		)
		SELECT * FROM claimed;
	END
	$$;

-- Latest definition: 285_cancel_job_outcome.sql. Same signature and grants; a waiting job it kills is dead as cancelled.
CREATE OR REPLACE FUNCTION app_cancel_job_outcome(p_id uuid, OUT status text, OUT changed boolean)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		changed := false;
		IF uid IS NULL THEN
			RETURN;
		END IF;
		-- Only a job this call changes: a waiting one, or a running one not flagged yet.
		UPDATE job j SET
			status = CASE WHEN j.status IN ('queued', 'failed') THEN 'dead' ELSE j.status END,
			dead_reason = CASE WHEN j.status IN ('queued', 'failed') THEN 'cancelled' ELSE j.dead_reason END,
			finished_at = CASE WHEN j.status IN ('queued', 'failed') THEN now() ELSE j.finished_at END,
			last_error = CASE WHEN j.status IN ('queued', 'failed') THEN 'cancelled' ELSE j.last_error END,
			cancel_requested_at = CASE WHEN j.status = 'running' THEN now() ELSE j.cancel_requested_at END
		WHERE j.id = p_id AND j.kind IN ('yield', 'delineate', 'future_yield', 'climate_factors')
		  AND (j.acting_user_id = uid OR app_has_role(j.project_id, 'editor'))
		  AND (j.status IN ('queued', 'failed') OR (j.status = 'running' AND j.cancel_requested_at IS NULL))
		RETURNING j.status INTO status;
		IF FOUND THEN
			changed := true;
			RETURN;
		END IF;
		-- Nothing to change (done, dead, or already flagged): its status as it is, or NULL when it isn't the caller's to cancel.
		SELECT j.status INTO status FROM job j
		WHERE j.id = p_id AND j.kind IN ('yield', 'delineate', 'future_yield', 'climate_factors')
		  AND (j.acting_user_id = uid OR app_has_role(j.project_id, 'editor'));
	END
	$$;
