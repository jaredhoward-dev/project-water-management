-- 348_email_gate_refusals — count Free's verified-email gate's refusals
-- (issue #641 § Free tier and abuse; docs/billing.md § Metrics and the abuse
-- report: "Disposable-domain rejections").
--
-- billing/emailGate.ts refuses an assistant turn or switching a feed on with
-- 403 email_unverified or email_disposable. The refusal rolls the route's
-- transaction back, so it is counted outside it: one autocommit call of
-- app_email_gate_refused (db/tx.ts queryWithoutUser), which survives the
-- rollback. The abuse report (billing/gatherReport.ts, as the schema owner)
-- sums the month's rows.
--
--   email_gate_refusal: one row per SAST day, code and feature, with a count.
--   No address, no domain, no user and no project: a count names nobody, so
--   it needs no erasure path and outlives every account. Owner only: RLS on,
--   no policy, no privilege to water_app; only app_email_gate_refused writes
--   it, and only the owner reads it.
--
-- No foreign key, so no covering index beyond the primary key.

CREATE TABLE email_gate_refusal (
	-- The day in Africa/Johannesburg, as the billing month (app_billing_month, 323).
	day      date NOT NULL,
	code     text NOT NULL CHECK (code IN ('email_unverified', 'email_disposable')),
	feature  text NOT NULL CHECK (feature IN ('assistant', 'feeds')),
	refusals integer NOT NULL DEFAULT 0 CHECK (refusals >= 0),
	PRIMARY KEY (day, code, feature)
);
COMMENT ON TABLE email_gate_refusal IS
	'Refusals by Free''s verified-email gate per SAST day, code and feature (348, issue #641): counts only, no address, user or project. Owner only; written by app_email_gate_refused alone.';
ALTER TABLE email_gate_refusal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON email_gate_refusal FROM PUBLIC, water_app;

-- Count one refusal today (SAST). Needs no signed-in user: it is called on
-- its own connection, after the gate has decided and before the route's
-- transaction rolls back. A bad code or feature raises (the CHECKs).
CREATE FUNCTION app_email_gate_refused(p_code text, p_feature text) RETURNS void
	LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
		INSERT INTO email_gate_refusal (day, code, feature, refusals)
		VALUES ((now() AT TIME ZONE 'Africa/Johannesburg')::date, p_code, p_feature, 1)
		ON CONFLICT (day, code, feature) DO UPDATE SET refusals = email_gate_refusal.refusals + 1;
	$$;
REVOKE ALL ON FUNCTION app_email_gate_refused(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_email_gate_refused(text, text) TO water_app;
COMMENT ON FUNCTION app_email_gate_refused(text, text) IS
	'Counts one refusal by Free''s verified-email gate today (SAST), by code and feature (348, issue #641). No address is passed or kept.';
