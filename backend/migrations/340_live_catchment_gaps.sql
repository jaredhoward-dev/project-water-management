-- 340_live_catchment_gaps — what 338 left of Free's one live catchment
-- (issue #641 round 9; docs/billing.md § Live catchments (Free)).
--
--   1. project_live_start_off, a BEFORE INSERT trigger on project: when
--      billing is enforced (app.billing_enforced = 'on', db/tx.ts) and a new
--      project would start with automatic runs on (a copy or an import of a
--      live catchment) while its account's live catchments are all in use,
--      the project starts with automatic runs off (settings.autoRun.enabled
--      false), never refused: Free never rations copying, importing or
--      modelling. A copy brings no feeds, alerts or publications (copyMap.ts:
--      feeds stay with the original; alert rules and publications don't
--      copy), and an import has none in its file, so automatic runs are the
--      only thing that makes a new project live. Named to fire after 323's
--      project_billing_account_set (triggers fire in name order), so the
--      account is known; under 334's account lock, so a parallel switch-on
--      waits for it. SECURITY DEFINER, as 338's triggers: the count reads
--      every project the account bills, not only those the caller sees.
--      The routes compare what they asked for with what was stored and say
--      so in the response (`autoRunsOff`, api.md).
--   2. project_move_live_guard, an AFTER UPDATE OF team_id, billing_account_id
--      trigger on project: a live project moving to another billing account
--      (into or out of a team) is checked against the new account's limit
--      by 338's app_live_catchment_guard, as switching it on there would be.
--      A project that isn't live moves freely; off unless enforced.
--   3. app_account_plan, redefined from 339 (its latest), adds
--      usage.liveCatchments { used, limit } (app_live_catchments_in_use,
--      338), so the Plan page shows "live catchments 1/1".
--
-- No new table, policy or grant: the trigger functions are owner-only
-- (EXECUTE revoked from water_app, as 338's), and app_account_plan keeps its
-- grant. Forward-only (CLAUDE.md rule 2): 338 and 339 stay as they are.

CREATE FUNCTION project_live_start_off() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_plan text;
		v_limit bigint;
	BEGIN
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on'
		   OR NEW.settings -> 'autoRun' ->> 'enabled' IS DISTINCT FROM 'true'
		   OR NEW.billing_account_id IS NULL THEN
			RETURN NEW;
		END IF;
		-- One account's limited changes one after the other (334's lock).
		PERFORM pg_advisory_xact_lock(hashtext('billing:' || NEW.billing_account_id::text));
		SELECT coalesce((SELECT s.plan_code FROM subscription s
			WHERE s.billing_account_id = NEW.billing_account_id AND s.status IN ('trialing', 'active', 'past_due')), 'free') INTO v_plan;
		SELECT (limits ->> 'live_catchments')::bigint INTO v_limit FROM plan WHERE code = v_plan;
		IF v_limit IS NOT NULL AND app_live_catchments_in_use(NEW.billing_account_id) >= v_limit THEN
			NEW.settings := jsonb_set(NEW.settings, '{autoRun,enabled}', 'false'::jsonb);
		END IF;
		RETURN NEW;
	END
	$$;
-- After project_billing_account_set ("l" > "b"), which sets the account.
CREATE TRIGGER project_live_start_off BEFORE INSERT ON project
	FOR EACH ROW EXECUTE FUNCTION project_live_start_off();

CREATE FUNCTION project_move_live_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF coalesce(current_setting('app.billing_enforced', true), '') <> 'on'
		   OR NEW.billing_account_id IS NOT DISTINCT FROM OLD.billing_account_id
		   OR NOT app_project_live_except(NEW.id, NULL, NULL, NULL, false) THEN
			RETURN NULL;
		END IF;
		PERFORM app_live_catchment_guard(NEW.id);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER project_move_live_guard AFTER UPDATE OF team_id, billing_account_id ON project
	FOR EACH ROW EXECUTE FUNCTION project_move_live_guard();
REVOKE ALL ON FUNCTION project_live_start_off(), project_move_live_guard() FROM PUBLIC, water_app;

-- From 339's definition, with usage.liveCatchments.
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
				-- Its live catchments (338: the one definition, app_live_catchments_in_use); limit null = unlimited.
				'liveCatchments', jsonb_build_object(
					'used', app_live_catchments_in_use(p_account),
					'limit', v_plan.limits -> 'live_catchments'),
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
