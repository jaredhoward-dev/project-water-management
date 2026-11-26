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

CREATE FUNCTION app_report_pdf_orphaned(p_project uuid, p_report uuid) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_project IS NULL OR p_report IS NULL THEN
			RAISE EXCEPTION 'name the report and its project' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF EXISTS (SELECT 1 FROM report r WHERE r.id = p_report) THEN
			RETURN false;
		END IF;
		INSERT INTO report_pdf_erasure (project_id, report_id) VALUES (p_project, p_report);
		RETURN true;
	END
	$$;

REVOKE ALL ON FUNCTION app_report_pdf_orphaned(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_report_pdf_orphaned(uuid, uuid) TO water_app;
