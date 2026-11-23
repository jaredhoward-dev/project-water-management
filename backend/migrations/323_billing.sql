-- 323_billing — plans, billing accounts, subscriptions and monthly usage
-- counters, in shadow mode (issue #641 Phase 1; docs/data-model.md § Billing).
--
-- Everything is counted, nothing is refused: no function here raises a limit
-- error. BILLING_ENFORCED (backend config) stays false until Phase 2.
--
--   1. plan: the tiers (free, pro, team), global, read by anyone, written only
--      by migrations. `limits` is a closed key set checked by
--      app_plan_limits_valid (JSON null = unlimited), because SQL reads it.
--   2. billing_account: a person's or a team's, exactly one of user_id /
--      team_id, each unique. ON DELETE CASCADE from both: deleting an account
--      (app_user, 138's rule: the operator deletes the row) or a team takes
--      its billing account, subscriptions and counters with it; the projects
--      it billed keep their rows with billing_account_id SET NULL. Phase 1
--      holds no invoices (the provider is Phase 3, which keeps invoices
--      apart from account deletion).
--   3. subscription: one live (trialing, active, past_due) per account, by a
--      partial unique index. No live subscription = Free.
--   4. usage_counter: reports and issued packs per account and month (the
--      first day of the month in Africa/Johannesburg). The assistant's
--      monthly total is summed from assistant_usage through
--      project.billing_account_id, never copied here.
--   5. project.billing_account_id (expand only, nullable): a team project
--      bills to its team's account, any other to its creator's. Backfilled
--      here, set on insert and on a team move by project_billing_account_set
--      (SECURITY DEFINER: water_app can't write billing_account), and never
--      written by water_app directly (project_billing_account_guard).
--      billing_account.projects_created counts every project an account has
--      ever billed (Free's lifetime count, issue #641 Enforcement design).
--   6. The six functions lane B calls (app_billing_plans,
--      app_my_billing_account, app_team_billing_account, app_account_plan,
--      app_entitlements, app_usage_add), all SECURITY DEFINER with a pinned
--      search_path. Plan data is never readable by a farmer, contributor or
--      viewer: app_entitlements needs editor or owner, app_account_plan the
--      account's person or an admin of its team.
--
-- water_app has SELECT only on the four tables (RLS: plan for all; an account,
-- its subscriptions and its counters for its person and its team's admins).

-- ---------------------------------------------------------------------------
-- 1. plan
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_plan_limits_valid(p_limits jsonb) RETURNS boolean
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
		SELECT jsonb_typeof(p_limits) = 'object'
			AND p_limits ?& ARRAY['catchments', 'editors_per_project', 'live_catchments', 'reports_per_month',
				'packs_included_per_month', 'seats_included', 'assistant_usd_micros_per_month', 'assistant_usd_micros_per_seat_month']
			AND (p_limits - ARRAY['catchments', 'editors_per_project', 'live_catchments', 'reports_per_month',
				'packs_included_per_month', 'seats_included', 'assistant_usd_micros_per_month', 'assistant_usd_micros_per_seat_month']) = '{}'::jsonb
			AND NOT EXISTS (
				SELECT 1 FROM jsonb_each(p_limits) e
				WHERE NOT (jsonb_typeof(e.value) = 'null'
					OR (jsonb_typeof(e.value) = 'number' AND (e.value #>> '{}')::numeric >= 0
						AND (e.value #>> '{}')::numeric = trunc((e.value #>> '{}')::numeric)))
			)
	$$;

CREATE TABLE plan (
	code                text PRIMARY KEY CHECK (code IN ('free', 'pro', 'team')),
	name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
	price_monthly_minor integer NOT NULL CHECK (price_monthly_minor >= 0),
	price_annual_minor  integer NOT NULL CHECK (price_annual_minor >= 0),
	currency            text NOT NULL DEFAULT 'ZAR' CHECK (currency ~ '^[A-Z]{3}$'),
	limits              jsonb NOT NULL CHECK (app_plan_limits_valid(limits)),
	features            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features) = 'object'),
	trial_days          integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
	active              boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE plan IS
	'The billing tiers (323, issue #641). Prices in minor units (ZAR cents); limits is a closed key set (app_plan_limits_valid), JSON null = unlimited. Written only by migrations.';

INSERT INTO plan (code, name, price_monthly_minor, price_annual_minor, limits, features, trial_days) VALUES
	('free', 'Free', 0, 0,
		'{"catchments": null, "editors_per_project": 2, "live_catchments": 1, "reports_per_month": 5, "packs_included_per_month": 0,
		  "seats_included": 1, "assistant_usd_micros_per_month": 1000000, "assistant_usd_micros_per_seat_month": null}',
		'{"scheduled_reports": false, "pack_price_minor": 149900, "support": "help"}', 0),
	('pro', 'Pro', 89900, 899000,
		'{"catchments": 15, "editors_per_project": 5, "live_catchments": null, "reports_per_month": null, "packs_included_per_month": 0,
		  "seats_included": 1, "assistant_usd_micros_per_month": 15000000, "assistant_usd_micros_per_seat_month": null}',
		'{"scheduled_reports": true, "pack_price_minor": 99900, "support": "email_2_business_days"}', 14),
	('team', 'Team', 249900, 2499000,
		'{"catchments": 50, "editors_per_project": null, "live_catchments": null, "reports_per_month": null, "packs_included_per_month": 3,
		  "seats_included": 3, "assistant_usd_micros_per_month": null, "assistant_usd_micros_per_seat_month": 15000000}',
		'{"scheduled_reports": true, "pack_price_minor": 99900, "extra_seat_monthly_minor": 49900, "extra_seat_annual_minor": 499000,
		  "support": "email_1_business_day"}', 30);

ALTER TABLE plan ENABLE ROW LEVEL SECURITY;
CREATE POLICY plan_read ON plan FOR SELECT USING (true);
GRANT SELECT ON plan TO water_app;

-- ---------------------------------------------------------------------------
-- 2. billing_account
-- ---------------------------------------------------------------------------
CREATE TABLE billing_account (
	id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	kind             text NOT NULL CHECK (kind IN ('user', 'team')),
	user_id          uuid UNIQUE REFERENCES app_user (id) ON DELETE CASCADE,
	team_id          uuid UNIQUE REFERENCES team (id) ON DELETE CASCADE,
	projects_created integer NOT NULL DEFAULT 0 CHECK (projects_created >= 0),
	created_at       timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT billing_account_one_owner CHECK (
		(kind = 'user' AND user_id IS NOT NULL AND team_id IS NULL) OR (kind = 'team' AND team_id IS NOT NULL AND user_id IS NULL)
	)
);
COMMENT ON TABLE billing_account IS
	'Who a project bills to (323, issue #641): a person (Pro) or a team (Team). Goes with its person or team. Written only by 323''s SECURITY DEFINER functions and triggers.';
COMMENT ON COLUMN billing_account.projects_created IS
	'Every project this account has billed, deleted or moved ones included (Free''s lifetime count; counted, not enforced, in Phase 1).';

-- The person's account, or an admin of its team (app_team_role, latest 026).
CREATE FUNCTION app_billing_account_readable(p_account uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NULL OR p_account IS NULL THEN
			RETURN false;
		END IF;
		RETURN EXISTS (
			SELECT 1 FROM billing_account a
			WHERE a.id = p_account
			  AND (a.user_id = uid OR (a.team_id IS NOT NULL AND app_team_role(a.team_id) = 'admin'))
		);
	END
	$$;
GRANT EXECUTE ON FUNCTION app_billing_account_readable(uuid) TO water_app;

ALTER TABLE billing_account ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_account_read ON billing_account FOR SELECT
	USING (user_id = app_current_user_id() OR (team_id IS NOT NULL AND app_team_role(team_id) = 'admin'));
GRANT SELECT ON billing_account TO water_app;

-- The account of a person or a team, made if missing. No caller check, so it
-- runs with its caller's rights (not SECURITY DEFINER): only the definer
-- functions and trigger below, which check theirs, can write through it.
CREATE FUNCTION billing_account_ensure(p_kind text, p_owner uuid) RETURNS uuid
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		v_id uuid;
	BEGIN
		IF p_owner IS NULL THEN
			RETURN NULL;
		END IF;
		IF p_kind = 'user' THEN
			SELECT id INTO v_id FROM billing_account WHERE user_id = p_owner;
			IF v_id IS NULL THEN
				INSERT INTO billing_account (kind, user_id) VALUES ('user', p_owner) ON CONFLICT (user_id) DO NOTHING RETURNING id INTO v_id;
				IF v_id IS NULL THEN
					SELECT id INTO v_id FROM billing_account WHERE user_id = p_owner;
				END IF;
			END IF;
		ELSIF p_kind = 'team' THEN
			SELECT id INTO v_id FROM billing_account WHERE team_id = p_owner;
			IF v_id IS NULL THEN
				INSERT INTO billing_account (kind, team_id) VALUES ('team', p_owner) ON CONFLICT (team_id) DO NOTHING RETURNING id INTO v_id;
				IF v_id IS NULL THEN
					SELECT id INTO v_id FROM billing_account WHERE team_id = p_owner;
				END IF;
			END IF;
		ELSE
			RAISE EXCEPTION 'unknown billing account kind %', p_kind USING ERRCODE = 'invalid_parameter_value';
		END IF;
		RETURN v_id;
	END
	$$;
REVOKE ALL ON FUNCTION billing_account_ensure(text, uuid) FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- 3. subscription
-- ---------------------------------------------------------------------------
CREATE TABLE subscription (
	id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	billing_account_id   uuid NOT NULL REFERENCES billing_account (id) ON DELETE CASCADE,
	plan_code            text NOT NULL REFERENCES plan (code),
	status               text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')),
	seats                integer NOT NULL DEFAULT 1 CHECK (seats >= 1),
	period_start         timestamptz,
	period_end           timestamptz,
	trial_end            timestamptz,
	cancel_at_period_end boolean NOT NULL DEFAULT false,
	provider             text NOT NULL CHECK (provider IN ('mock', 'manual', 'stripe')),
	external_ref         text CHECK (external_ref IS NULL OR length(external_ref) BETWEEN 1 AND 255),
	created_at           timestamptz NOT NULL DEFAULT now(),
	CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start),
	UNIQUE (provider, external_ref)
);
-- Covers the account key (the partial index below covers live rows only).
CREATE INDEX subscription_account_idx ON subscription (billing_account_id, created_at);
CREATE INDEX subscription_plan_idx ON subscription (plan_code);
-- One live subscription per account (feohledger's uq_subscription_one_live_per_org).
CREATE UNIQUE INDEX subscription_one_live_per_account ON subscription (billing_account_id)
	WHERE status IN ('trialing', 'active', 'past_due');
COMMENT ON TABLE subscription IS
	'A billing account''s plan over time (323, issue #641). At most one live (trialing, active, past_due) per account; none = Free. Written only by definer functions (the provider webhook, Phase 3; the staff grant, Phase 2).';

ALTER TABLE subscription ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscription_read ON subscription FOR SELECT USING (app_billing_account_readable(billing_account_id));
GRANT SELECT ON subscription TO water_app;

-- ---------------------------------------------------------------------------
-- 4. usage_counter
-- ---------------------------------------------------------------------------
CREATE TABLE usage_counter (
	billing_account_id uuid NOT NULL REFERENCES billing_account (id) ON DELETE CASCADE,
	kind               text NOT NULL CHECK (kind IN ('reports', 'packs_issued')),
	-- The first day of the month in Africa/Johannesburg (app_billing_month).
	month              date NOT NULL CHECK (month = date_trunc('month', month)::date),
	qty                bigint NOT NULL DEFAULT 0 CHECK (qty >= 0),
	PRIMARY KEY (billing_account_id, kind, month)
);
COMMENT ON TABLE usage_counter IS
	'Monthly counts per billing account (323, issue #641): server reports and issued packs, per SAST month. Written only by app_usage_add.';

ALTER TABLE usage_counter ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_counter_read ON usage_counter FOR SELECT USING (app_billing_account_readable(billing_account_id));
GRANT SELECT ON usage_counter TO water_app;

-- The billing month: the first day of the current month in South Africa.
-- p_at is for tests of the month's edge; callers use the default.
CREATE FUNCTION app_billing_month(p_at timestamptz DEFAULT now()) RETURNS date
	LANGUAGE sql STABLE SET search_path = public
	AS $$ SELECT date_trunc('month', p_at AT TIME ZONE 'Africa/Johannesburg')::date $$;

-- ---------------------------------------------------------------------------
-- 5. project.billing_account_id
-- ---------------------------------------------------------------------------
ALTER TABLE project ADD COLUMN billing_account_id uuid REFERENCES billing_account (id) ON DELETE SET NULL;
CREATE INDEX project_billing_account_idx ON project (billing_account_id);
COMMENT ON COLUMN project.billing_account_id IS
	'The account this project bills to (323, issue #641): its team''s, else its creator''s. Set by project_billing_account_set; NULL once that account is deleted.';

-- Backfill: each project without an account gets its team's, else its
-- creator's (made as needed), and each account counts the projects it bills.
-- Idempotent; owner-only (the migration runs it once as the schema owner, and
-- billing.db.test.ts runs it on synthetic rows in a rolled-back transaction).
CREATE FUNCTION billing_backfill() RETURNS void
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		INSERT INTO billing_account (kind, team_id)
			SELECT DISTINCT 'team', p.team_id FROM project p WHERE p.team_id IS NOT NULL AND p.billing_account_id IS NULL
			ON CONFLICT (team_id) DO NOTHING;
		INSERT INTO billing_account (kind, user_id)
			SELECT DISTINCT 'user', p.created_by FROM project p
			WHERE p.team_id IS NULL AND p.created_by IS NOT NULL AND p.billing_account_id IS NULL
			ON CONFLICT (user_id) DO NOTHING;
		UPDATE project p SET billing_account_id = a.id
			FROM billing_account a
			WHERE p.billing_account_id IS NULL
			  AND ((p.team_id IS NOT NULL AND a.team_id = p.team_id) OR (p.team_id IS NULL AND a.user_id = p.created_by));
		UPDATE billing_account a SET projects_created = greatest(a.projects_created, c.n)
			FROM (SELECT billing_account_id, count(*)::int AS n FROM project WHERE billing_account_id IS NOT NULL GROUP BY 1) c
			WHERE c.billing_account_id = a.id;
	END
	$$;
REVOKE ALL ON FUNCTION billing_backfill() FROM PUBLIC, water_app;
SELECT billing_backfill();

-- water_app never writes the column itself: only the trigger below does.
CREATE FUNCTION project_billing_account_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF current_user = 'water_app' AND NEW.billing_account_id IS DISTINCT FROM OLD.billing_account_id
		   AND NEW.team_id IS NOT DISTINCT FROM OLD.team_id THEN
			RAISE EXCEPTION 'a project''s billing account follows its team or its creator' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN NEW;
	END
	$$;
-- Named to fire before project_billing_account_set (triggers fire in name order).
CREATE TRIGGER project_billing_account_guard BEFORE UPDATE OF billing_account_id ON project
	FOR EACH ROW EXECUTE FUNCTION project_billing_account_guard();

-- On insert, and when the project moves into or out of a team: the team's
-- account, else the creator's (made if missing). Counts the project on the
-- account it lands on.
CREATE FUNCTION project_billing_account_set() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
	BEGIN
		IF TG_OP = 'UPDATE' AND NEW.team_id IS NOT DISTINCT FROM OLD.team_id THEN
			RETURN NEW;
		END IF;
		IF NEW.team_id IS NOT NULL THEN
			v_account := billing_account_ensure('team', NEW.team_id);
		ELSE
			v_account := billing_account_ensure('user', NEW.created_by);
		END IF;
		IF TG_OP = 'INSERT' OR v_account IS DISTINCT FROM OLD.billing_account_id THEN
			UPDATE billing_account SET projects_created = projects_created + 1 WHERE id = v_account;
		END IF;
		NEW.billing_account_id := v_account;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER project_billing_account_set BEFORE INSERT OR UPDATE OF team_id ON project
	FOR EACH ROW EXECUTE FUNCTION project_billing_account_set();
REVOKE ALL ON FUNCTION project_billing_account_guard(), project_billing_account_set() FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- 6. The functions the backend calls
-- ---------------------------------------------------------------------------

-- The active plans, for anyone (the public pricing route).
CREATE FUNCTION app_billing_plans() RETURNS SETOF plan
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$ SELECT * FROM plan WHERE active ORDER BY price_monthly_minor, code $$;
GRANT EXECUTE ON FUNCTION app_billing_plans() TO water_app;

-- The caller's own account, made if missing; NULL with no signed-in user.
CREATE FUNCTION app_my_billing_account() RETURNS uuid
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN billing_account_ensure('user', app_current_user_id());
	END
	$$;
GRANT EXECUTE ON FUNCTION app_my_billing_account() TO water_app;

-- The team's account, made if missing, for an admin of the team; NULL for anyone else.
CREATE FUNCTION app_team_billing_account(p_team uuid) RETURNS uuid
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF app_current_user_id() IS NULL OR app_team_role(p_team) IS DISTINCT FROM 'admin' THEN
			RETURN NULL;
		END IF;
		RETURN billing_account_ensure('team', p_team);
	END
	$$;
GRANT EXECUTE ON FUNCTION app_team_billing_account(uuid) TO water_app;

-- The account's plan: its live subscription's, else free (caller's rights, like billing_account_ensure).
CREATE FUNCTION billing_account_plan_code(p_account uuid) RETURNS text
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT coalesce(
			(SELECT plan_code FROM subscription
			 WHERE billing_account_id = p_account AND status IN ('trialing', 'active', 'past_due')),
			'free')
	$$;
REVOKE ALL ON FUNCTION billing_account_plan_code(uuid) FROM PUBLIC, water_app;

-- The plan and this month's usage of an account, for its person or an admin of its team; NULL otherwise.
CREATE FUNCTION app_account_plan(p_account uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_kind text;
		v_plan plan;
		v_sub subscription;
		v_month date := app_billing_month();
	BEGIN
		IF NOT app_billing_account_readable(p_account) THEN
			RETURN NULL;
		END IF;
		SELECT kind INTO v_kind FROM billing_account WHERE id = p_account;
		SELECT * INTO v_sub FROM subscription
			WHERE billing_account_id = p_account AND status IN ('trialing', 'active', 'past_due');
		SELECT * INTO v_plan FROM plan WHERE code = coalesce(v_sub.plan_code, 'free');
		RETURN jsonb_build_object(
			'account', jsonb_build_object('id', p_account, 'kind', v_kind),
			'plan', jsonb_build_object(
				'code', v_plan.code, 'name', v_plan.name,
				'priceMonthlyMinor', v_plan.price_monthly_minor, 'priceAnnualMinor', v_plan.price_annual_minor,
				'currency', v_plan.currency, 'limits', v_plan.limits, 'features', v_plan.features
			),
			'subscription', CASE WHEN v_sub.id IS NULL THEN NULL ELSE jsonb_build_object(
				'status', v_sub.status, 'seats', v_sub.seats, 'periodStart', v_sub.period_start, 'periodEnd', v_sub.period_end,
				'trialEnd', v_sub.trial_end, 'cancelAtPeriodEnd', v_sub.cancel_at_period_end
			) END,
			'usage', jsonb_build_object(
				'month', to_char(v_month, 'YYYY-MM'),
				-- Every project the account bills (projects have no archived or deleted state yet: a deleted one is gone).
				'catchments', jsonb_build_object(
					'used', (SELECT count(*) FROM project WHERE billing_account_id = p_account),
					'limit', v_plan.limits -> 'catchments'),
				'reports', jsonb_build_object(
					'used', coalesce((SELECT qty FROM usage_counter WHERE billing_account_id = p_account AND kind = 'reports' AND month = v_month), 0),
					'limit', v_plan.limits -> 'reports_per_month'),
				'packsIssued', jsonb_build_object(
					'used', coalesce((SELECT qty FROM usage_counter WHERE billing_account_id = p_account AND kind = 'packs_issued' AND month = v_month), 0),
					'limit', v_plan.limits -> 'packs_included_per_month'),
				-- Weighted tokens (input + 5 × output) over the account's projects, in assistant_usage's own (UTC) month (262).
				'assistantTokens', jsonb_build_object(
					'used', coalesce((
						SELECT sum(u.input_tokens + 5 * u.output_tokens) FROM assistant_usage u JOIN project p ON p.id = u.project_id
						WHERE p.billing_account_id = p_account AND u.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
					), 0),
					'limit', NULL)
			)
		);
	END
	$$;
GRANT EXECUTE ON FUNCTION app_account_plan(uuid) TO water_app;

-- The plan a project is on, for its editors and owners; NULL for anyone else (farmers, contributors and viewers never see plan data).
CREATE FUNCTION app_entitlements(p_project uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
		v_status text;
		v_plan plan;
	BEGIN
		IF NOT app_has_role(p_project, 'editor') THEN
			RETURN NULL;
		END IF;
		SELECT billing_account_id INTO v_account FROM project WHERE id = p_project;
		SELECT status INTO v_status FROM subscription
			WHERE billing_account_id = v_account AND status IN ('trialing', 'active', 'past_due');
		SELECT * INTO v_plan FROM plan WHERE code = billing_account_plan_code(v_account);
		RETURN jsonb_build_object('plan', v_plan.code, 'limits', v_plan.limits, 'features', v_plan.features, 'status', v_status);
	END
	$$;
GRANT EXECUTE ON FUNCTION app_entitlements(uuid) TO water_app;

-- Count p_qty of p_kind against the project's account this SAST month. Any role on the project may count; shadow mode:
-- never refuses for a limit. A project with no account (its creator deleted, no team) counts nowhere.
CREATE FUNCTION app_usage_add(p_project uuid, p_kind text, p_qty bigint DEFAULT 1) RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
	BEGIN
		IF app_project_role(p_project) IS NULL THEN
			RAISE EXCEPTION 'no role on project %', p_project USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_kind IS NULL OR p_kind NOT IN ('reports', 'packs_issued') THEN
			RAISE EXCEPTION 'unknown usage kind %', p_kind USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF p_qty IS NULL OR p_qty < 1 THEN
			RAISE EXCEPTION 'usage quantity must be at least 1' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		SELECT billing_account_id INTO v_account FROM project WHERE id = p_project;
		IF v_account IS NULL THEN
			RETURN;
		END IF;
		INSERT INTO usage_counter (billing_account_id, kind, month, qty) VALUES (v_account, p_kind, app_billing_month(), p_qty)
			ON CONFLICT (billing_account_id, kind, month) DO UPDATE SET qty = usage_counter.qty + EXCLUDED.qty;
	END
	$$;
GRANT EXECUTE ON FUNCTION app_usage_add(uuid, text, bigint) TO water_app;
