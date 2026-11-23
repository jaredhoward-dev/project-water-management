-- 325_billing_metrics — the rows behind the Phase 1 metrics and the staff
-- abuse report (issue #641, "Phase 1 metrics and thresholds", "Free tier and
-- abuse"; docs/billing.md § Metrics and the abuse report).
--
-- Two read-only functions for the operator, run as the schema owner by
-- `pnpm dev:billing:report` (backend/scripts/billing-report.ts). The maths
-- (shares, percentiles, clusters) is TypeScript (src/billing/metrics.ts);
-- these only gather the month's rows, with the month's edges worked out here
-- in Africa/Johannesburg, whatever the session's time zone.
--
-- Owner only: caller's rights (not SECURITY DEFINER, so the catalogue's
-- definer guards don't apply), and EXECUTE revoked from PUBLIC and
-- water_app, like billing_account_plan_code (323). The app never calls them:
-- they read every account and every person's address.

-- One row per billing account: its plan today, when its person or team
-- started, its catchments today, and the month's runs, reports and assistant
-- use. p_month is the month's first day (SAST for runs and reports;
-- assistant_usage keeps its own UTC month, 262).
CREATE FUNCTION billing_metrics_accounts(p_month date) RETURNS TABLE (
	account_id uuid,
	kind text,
	plan_code text,
	started_at timestamptz,
	catchments bigint,
	runs bigint,
	reports bigint,
	assistant_usd_micros bigint,
	unpriced_turns bigint,
	last_spend_at timestamptz
)
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		WITH bounds AS (
			SELECT date_trunc('month', p_month)::date AS m,
			       (date_trunc('month', p_month)::date)::timestamp AT TIME ZONE 'Africa/Johannesburg' AS lo,
			       ((date_trunc('month', p_month)::date + interval '1 month')::timestamp) AT TIME ZONE 'Africa/Johannesburg' AS hi
		)
		SELECT
			ba.id,
			ba.kind,
			billing_account_plan_code(ba.id),
			coalesce(u.created_at, t.created_at, ba.created_at),
			(SELECT count(*) FROM project p WHERE p.billing_account_id = ba.id),
			(SELECT count(*) FROM model_run r JOIN project p ON p.id = r.project_id, bounds b
			 WHERE p.billing_account_id = ba.id AND r.created_at >= b.lo AND r.created_at < b.hi),
			coalesce((SELECT c.qty FROM usage_counter c, bounds b WHERE c.billing_account_id = ba.id AND c.kind = 'reports' AND c.month = b.m), 0),
			coalesce(a.cost, 0),
			coalesce(a.unpriced, 0),
			a.last_at
		FROM billing_account ba
		LEFT JOIN app_user u ON u.id = ba.user_id
		LEFT JOIN team t ON t.id = ba.team_id
		LEFT JOIN LATERAL (
			SELECT sum(au.cost_usd_micros)::bigint AS cost, sum(au.unpriced_turns)::bigint AS unpriced, max(au.updated_at) AS last_at
			FROM assistant_usage au JOIN project p ON p.id = au.project_id, bounds b
			WHERE p.billing_account_id = ba.id AND au.month = b.m
		) a ON true
	$$;
REVOKE ALL ON FUNCTION billing_metrics_accounts(date) FROM PUBLIC, water_app;
COMMENT ON FUNCTION billing_metrics_accounts(date) IS
	'Owner only (325, issue #641): per billing account, the month''s runs, reports and assistant spend for pnpm dev:billing:report.';

-- One row per person: their address (the report canonicalises it and prints it
-- only with --show-emails), when they signed up and verified, their first run,
-- and whether they signed up in the month and on which SAST day.
CREATE FUNCTION billing_metrics_people(p_month date) RETURNS TABLE (
	user_id uuid,
	email text,
	created_at timestamptz,
	verified boolean,
	first_run_at timestamptz,
	in_month boolean,
	signup_day date
)
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT
			u.id,
			u.email::text,
			u.created_at,
			u.email_verified_at IS NOT NULL,
			(SELECT min(r.created_at) FROM model_run r WHERE r.created_by = u.id),
			date_trunc('month', u.created_at AT TIME ZONE 'Africa/Johannesburg')::date = date_trunc('month', p_month)::date,
			(u.created_at AT TIME ZONE 'Africa/Johannesburg')::date
		FROM app_user u
	$$;
REVOKE ALL ON FUNCTION billing_metrics_people(date) FROM PUBLIC, water_app;
COMMENT ON FUNCTION billing_metrics_people(date) IS
	'Owner only (325, issue #641): every person''s sign-up, verification and first run, for pnpm dev:billing:report''s activation and abuse signals.';
