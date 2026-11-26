-- 395_report_pdf_erasure — a deleted report row's PDF leaves storage too
-- (issue #903; docs/security.md § Personal information, docs/architecture.md
-- § Server-side reports).
--
-- A report row goes with its requester's account (023: report.requested_by
-- ON DELETE CASCADE) and with its project, but its PDF stayed in storage:
-- until the reports bucket's 7-day lifecycle in production, and for good
-- under STORAGE=local (MinIO has no lifecycle; purgeReports deletes local
-- PDFs only for the rows it purges itself). Neither deletion path can reach
-- storage from SQL: the operator deletes the app_user row as the schema owner
-- (deployment.md § Runbooks, item 7), and DELETE /auth/me runs in the API,
-- which has no grant on the bucket. So, as erasure_log does (159), a trigger
-- records what went, and the worker's tick removes it:
--
--  1. report_pdf_erasure (project_id, report_id, queued_at, attempts): the
--     ids of a deleted report whose PDF may still be stored. The object key
--     is derived from them in code (reports/storage.ts reportKey), never
--     stored, like every other report key. No foreign keys, so the row
--     outlives the report. RLS on, no policies, no grant to water_app: only
--     the definer functions below read or write it (catalogue.db.test.ts
--     OWNER_ONLY). It holds ids only, never a name or address.
--  2. report_pdf_erasure_record(): AFTER DELETE on report, for every row
--     younger than 8 days, whatever deleted it (an account's or a project's
--     cascade, or SQL by hand). Older rows are purgeReports' own (8 days, a
--     day past the PDFs' 7), whose PDFs the lifecycle (production) or
--     purgeReports itself (local) already removes.
--  3. app_report_pdf_erasures(p_limit): the worker claims up to p_limit
--     entries, fewest attempts first, from its own context only (051's
--     alert_worker_context); app_report_pdf_erasures_settle(p_done,
--     p_failed) deletes the entries whose object is gone and counts an
--     attempt on the rest, which the next tick retries
--     (reports/erasure.ts erasePendingReportPdfs).

CREATE TABLE report_pdf_erasure (
	id         bigserial PRIMARY KEY,
	project_id uuid NOT NULL,
	report_id  uuid NOT NULL,
	queued_at  timestamptz NOT NULL DEFAULT now(),
	attempts   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
COMMENT ON TABLE report_pdf_erasure IS
	'Deleted reports whose PDFs the worker tick still has to remove from storage (395, issue #903). Ids only; owner-only.';
CREATE INDEX report_pdf_erasure_queue_idx ON report_pdf_erasure (attempts, queued_at);

ALTER TABLE report_pdf_erasure ENABLE ROW LEVEL SECURITY;
-- No policies and no grant: water_app can neither read nor write it.
REVOKE ALL ON report_pdf_erasure FROM PUBLIC, water_app;
REVOKE ALL ON SEQUENCE report_pdf_erasure_id_seq FROM PUBLIC, water_app;

CREATE FUNCTION report_pdf_erasure_record() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF OLD.created_at > now() - interval '8 days' THEN
			INSERT INTO report_pdf_erasure (project_id, report_id) VALUES (OLD.project_id, OLD.id);
		END IF;
		RETURN NULL;
	END
	$$;
REVOKE ALL ON FUNCTION report_pdf_erasure_record() FROM PUBLIC, water_app;

CREATE TRIGGER report_pdf_erasure AFTER DELETE ON report
	FOR EACH ROW EXECUTE FUNCTION report_pdf_erasure_record();

CREATE FUNCTION app_report_pdf_erasures(p_limit integer)
	RETURNS TABLE (id bigint, project_id uuid, report_id uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker removes report PDFs' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
			RAISE EXCEPTION 'claim between 1 and 1000 report PDFs' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		RETURN QUERY
			SELECT e.id, e.project_id, e.report_id FROM report_pdf_erasure e
			ORDER BY e.attempts, e.queued_at, e.id
			LIMIT p_limit
			FOR UPDATE SKIP LOCKED;
	END
	$$;

CREATE FUNCTION app_report_pdf_erasures_settle(p_done bigint[], p_failed bigint[]) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_count integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker removes report PDFs' USING ERRCODE = 'insufficient_privilege';
		END IF;
		UPDATE report_pdf_erasure SET attempts = attempts + 1 WHERE id = ANY (coalesce(p_failed, '{}'));
		DELETE FROM report_pdf_erasure WHERE id = ANY (coalesce(p_done, '{}'));
		GET DIAGNOSTICS v_count = ROW_COUNT;
		RETURN v_count;
	END
	$$;

REVOKE ALL ON FUNCTION app_report_pdf_erasures(integer), app_report_pdf_erasures_settle(bigint[], bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_report_pdf_erasures(integer), app_report_pdf_erasures_settle(bigint[], bigint[]) TO water_app;
