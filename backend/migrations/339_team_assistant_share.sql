-- 339_team_assistant_share — a team admin sets the share of the team's
-- monthly assistant dollars one member may use (issue #641 "Team: $15 ×
-- editor seats, pooled. One person may use at most 50% unless a team admin
-- raises it"; docs/billing.md § Assistant dollar caps).
--
--   1. app_team_set_assistant_share(team, pct): the only writer of
--      billing_account.assistant_member_max_pct (336) outside the schema
--      owner. SECURITY DEFINER, as every billing_account write is (323's
--      header: water_app has SELECT only). Only an admin of the team
--      (app_team_role, as app_team_billing_account): anyone else gets NULL,
--      so the route answers 404 and says nothing of the team. The team's
--      account is made on first ask (billing_account_ensure, as
--      app_team_billing_account does), so an admin can set the share before
--      the team subscribes. A pct outside 1–100 (or NULL) is refused with
--      SQLSTATE 23514, as the column's own CHECK would (the API answers its
--      zod 400 first). Answers the share now stored.
--   2. app_account_plan, redefined from 334 (its latest), adds
--      team.assistantMemberMaxPct, so the team's Plan page shows the share.
--
-- No new table or policy. The share is read by app_assistant_begin (336) at
-- each turn, so a change binds from the next turn; refusing past it stays off
-- unless billing is enforced (app.billing_enforced), as 336 says.

CREATE FUNCTION app_team_set_assistant_share(p_team uuid, p_pct integer) RETURNS smallint
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
		v_pct smallint;
	BEGIN
		IF app_current_user_id() IS NULL OR p_team IS NULL OR app_team_role(p_team) IS DISTINCT FROM 'admin' THEN
			RETURN NULL;
		END IF;
		IF p_pct IS NULL OR p_pct NOT BETWEEN 1 AND 100 THEN
			RAISE EXCEPTION 'the assistant share is a whole percentage from 1 to 100'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'billing_account_assistant_member_max_pct_check';
		END IF;
		v_account := billing_account_ensure('team', p_team);
		UPDATE billing_account SET assistant_member_max_pct = p_pct WHERE id = v_account
			RETURNING assistant_member_max_pct INTO v_pct;
		RETURN v_pct;
	END
	$$;
REVOKE ALL ON FUNCTION app_team_set_assistant_share(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_team_set_assistant_share(uuid, integer) TO water_app;
COMMENT ON FUNCTION app_team_set_assistant_share(uuid, integer) IS
	'A team admin sets the share (1–100%) of the team''s monthly assistant dollars one member may use (339, issue #641); NULL to anyone else.';

COMMENT ON COLUMN billing_account.assistant_member_max_pct IS
	'On a per-seat plan (Team), the share of the account''s monthly assistant dollars one person may use (336; #641: 50%, a team admin may raise it, app_team_set_assistant_share, 339).';

-- From 334's definition, with team.assistantMemberMaxPct.
CREATE OR REPLACE FUNCTION app_account_plan(p_account uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_kind text;
		v_plan plan;
		v_sub subscription;
		v_month date := app_billing_month();
		v_utc_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
		v_tokens bigint;
		v_cost bigint;
		v_unpriced bigint;
		v_seats bigint;
		v_cost_limit bigint;
		v_team uuid;
		v_editors bigint;
		v_member_pct smallint;
	BEGIN
		IF NOT app_billing_account_readable(p_account) THEN
			RETURN NULL;
		END IF;
		SELECT kind, team_id, assistant_member_max_pct INTO v_kind, v_team, v_member_pct FROM billing_account WHERE id = p_account;
		-- A team's editor seats in use (334: the one definition, app_team_seats_in_use).
		IF v_kind = 'team' THEN
			v_editors := app_team_seats_in_use(v_team);
		END IF;
		SELECT * INTO v_sub FROM subscription
			WHERE billing_account_id = p_account AND status IN ('trialing', 'active', 'past_due');
		SELECT * INTO v_plan FROM plan WHERE code = coalesce(v_sub.plan_code, 'free');
		-- The account's projects' assistant use in assistant_usage's own (UTC) month (262).
		SELECT coalesce(sum(u.input_tokens + 5 * u.output_tokens), 0), coalesce(sum(u.cost_usd_micros), 0), coalesce(sum(u.unpriced_turns), 0)
			INTO v_tokens, v_cost, v_unpriced
			FROM assistant_usage u JOIN project p ON p.id = u.project_id
			WHERE p.billing_account_id = p_account AND u.month = v_utc_month;
		-- A per-account allowance, else a per-seat one × the seats (the live subscription's, never fewer than included).
		v_cost_limit := (v_plan.limits ->> 'assistant_usd_micros_per_month')::bigint;
		IF v_cost_limit IS NULL AND (v_plan.limits ->> 'assistant_usd_micros_per_seat_month') IS NOT NULL THEN
			v_seats := greatest(coalesce((v_plan.limits ->> 'seats_included')::bigint, 1), coalesce(v_sub.seats, 0));
			v_cost_limit := (v_plan.limits ->> 'assistant_usd_micros_per_seat_month')::bigint * v_seats;
		END IF;
		RETURN jsonb_build_object(
			'account', jsonb_build_object('id', p_account, 'kind', v_kind),
			'plan', jsonb_build_object(
				'code', v_plan.code, 'name', v_plan.name,
				'priceMonthlyMinor', v_plan.price_monthly_minor, 'priceAnnualMinor', v_plan.price_annual_minor,
				'currency', v_plan.currency, 'limits', v_plan.limits, 'features', v_plan.features
			),
			'subscription', CASE WHEN v_sub.id IS NULL THEN NULL ELSE jsonb_build_object(
				'status', v_sub.status, 'seats', v_sub.seats, 'periodStart', v_sub.period_start, 'periodEnd', v_sub.period_end,
				'trialEnd', v_sub.trial_end, 'cancelAtPeriodEnd', v_sub.cancel_at_period_end, 'interval', v_sub.billing_interval
			) END,
			-- A team account's editor count (332) and the share of its assistant dollars one member may use (339); null on a person's.
			'team', CASE WHEN v_kind = 'team' THEN jsonb_build_object('editorCount', v_editors, 'assistantMemberMaxPct', v_member_pct) END,
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
				-- Weighted tokens (input + 5 × output).
				'assistantTokens', jsonb_build_object('used', v_tokens, 'limit', NULL),
				'assistantCost', jsonb_build_object('usedUsdMicros', v_cost, 'limitUsdMicros', v_cost_limit, 'unpricedTurns', v_unpriced)
			)
		);
	END
	$$;
GRANT EXECUTE ON FUNCTION app_account_plan(uuid) TO water_app;
