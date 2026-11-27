-- 402: the billing metrics count only a person's own runs (issue #641 Phase 1
-- metrics; docs/billing.md § Metrics and the abuse report).
--
-- 325's billing_metrics_accounts counted every model_run of the month as the
-- account's activity, and billing_metrics_people took any run as a person's
-- first. But the app makes runs by itself: a live catchment's re-runs when
-- data arrives (model_run.trigger 'auto') and its forecast runs ('forecast',
-- 042). So an idle account with automatic runs on counted as active in the
-- report's "active Free accounts near / at each limit" (the denominator of
-- every share there), against the doc's "an idle account with a live
-- catchment isn't in the share", and an automatic run within 7 days of
-- signing up activated its person. Both now count trigger = 'manual' only
-- (a run a person asked for: the live model, a scenario, a calibration).
--
-- Both functions from their latest definitions (325; nothing replaced them
-- since), changed only in those two run subqueries. Same signatures and
-- return types, so CREATE OR REPLACE keeps 325's owner-only EXECUTE grants;
-- the REVOKEs are repeated anyway.

CREATE OR REPLACE FUNCTION billing_metrics_accounts(p_month date) RETURNS TABLE (
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
			 WHERE p.billing_account_id = ba.id AND r.trigger = 'manual' AND r.created_at >= b.lo AND r.created_at < b.hi),
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
	'Owner only (325, 402, issue #641): per billing account, the month''s runs a person asked for (trigger manual), reports and assistant spend for pnpm dev:billing:report.';

CREATE OR REPLACE FUNCTION billing_metrics_people(p_month date) RETURNS TABLE (
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
			(SELECT min(r.created_at) FROM model_run r WHERE r.created_by = u.id AND r.trigger = 'manual'),
			date_trunc('month', u.created_at AT TIME ZONE 'Africa/Johannesburg')::date = date_trunc('month', p_month)::date,
			(u.created_at AT TIME ZONE 'Africa/Johannesburg')::date
		FROM app_user u
	$$;
REVOKE ALL ON FUNCTION billing_metrics_people(date) FROM PUBLIC, water_app;
COMMENT ON FUNCTION billing_metrics_people(date) IS
	'Owner only (325, 402, issue #641): every person''s sign-up, verification and first run they asked for (trigger manual), for pnpm dev:billing:report''s activation and abuse signals.';
