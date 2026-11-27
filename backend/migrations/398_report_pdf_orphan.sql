-- 398_report_pdf_orphan — a PDF stored after its report was deleted leaves
-- storage too (issue #911; follows 395_report_pdf_erasure, docs/architecture.md
-- § Server-side reports).
--
-- 395 queues a deleted report's ids when the row goes, and the worker's tick
-- removes the PDF. A render still in progress at that moment stores its PDF
-- afterwards, possibly after the tick already removed nothing (there was
-- nothing yet) and settled the entry, so the late PDF stayed: until the
-- bucket's 7-day lifecycle in production, for good in local MinIO.
--
-- app_report_pdf_orphaned(p_project, p_report) is asked by whoever stored a
-- report's PDF, right after storing it: the inline render (jobs/handlers/
-- report-render.ts, in the job's transaction as the acting user, who may be
-- the very account being deleted) and, for the renderer Lambda (which has no
-- database), the worker when the Lambda's answer arrives (reports/schedule.ts
-- acceptRenderResult). When no report row has that id, it queues the ids in
-- report_pdf_erasure, as 395's trigger does, and answers true; the tick's
-- erasure then removes the object, with its retries. When the row exists it
-- does nothing and answers false: its PDF is live, or the row's own deletion
-- (later than this check, so later than the store) queues it through 395.
--
-- The check is by report id alone, across projects: with no report of that
-- id anywhere, the key reports/<p_project>/<p_report>.pdf is no live
-- report's PDF, whatever project id the caller names. Definer, because RLS
-- would hide a row the caller can't see (a deleted requester's), which must
-- not read as gone; it reveals only whether a report id exists. Ids only.
--
-- Who may ask, and how much it can queue: a signed-in caller (the inline
-- render's acting user) or the worker on the Lambda's answer, which marks
-- its transaction with app.worker_context = 'on' (reports/schedule.ts). A
-- session with no user and no API key is not enough: public routes and the
-- pre-sign-in flows run so too (withoutUser), and they are refused, as is an
-- API key's session. The marker is a transaction setting, like
-- app.current_user_id: only the backend's own code sets either. And only for a project that
-- exists or did (erasure_log's 'project' row: a project deleted mid-render,
-- whose late PDF is exactly the orphan). report_pdf_erasure gets a unique
-- (project_id, report_id), so the queue holds one entry per object key
-- however often a key is named (395's trigger queues a report once; any
-- duplicates already queued are folded first). A key already queued is
-- re-queued under a new id with its attempts reset: the settle of a claim in
-- flight (395's app_report_pdf_erasures_settle deletes by id) may have removed
-- the object before this PDF was stored, and must not take the entry with it.

DELETE FROM report_pdf_erasure a USING report_pdf_erasure b
	WHERE a.project_id = b.project_id AND a.report_id = b.report_id AND a.id > b.id;
CREATE UNIQUE INDEX report_pdf_erasure_key_idx ON report_pdf_erasure (project_id, report_id);

CREATE FUNCTION app_report_pdf_orphaned(p_project uuid, p_report uuid) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_project IS NULL OR p_report IS NULL THEN
			RAISE EXCEPTION 'name the report and its project' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF app_current_user_id() IS NULL
		   AND NOT (alert_worker_context() AND coalesce(current_setting('app.worker_context', true), '') = 'on') THEN
			RAISE EXCEPTION 'only a signed-in render or the worker reports a stored PDF' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF EXISTS (SELECT 1 FROM report r WHERE r.id = p_report) THEN
			RETURN false;
		END IF;
		IF NOT EXISTS (SELECT 1 FROM project WHERE id = p_project)
		   AND NOT EXISTS (SELECT 1 FROM erasure_log WHERE kind = 'project' AND subject_id = p_project) THEN
			RAISE EXCEPTION 'no such project' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		-- One entry per key; a key already queued is re-queued under a new id (a settle in flight deletes by the old one).
		INSERT INTO report_pdf_erasure (project_id, report_id) VALUES (p_project, p_report)
			ON CONFLICT (project_id, report_id) DO UPDATE
			SET id = nextval('report_pdf_erasure_id_seq'), attempts = 0, queued_at = now();
		RETURN true;
	END
	$$;

REVOKE ALL ON FUNCTION app_report_pdf_orphaned(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_report_pdf_orphaned(uuid, uuid) TO water_app;
