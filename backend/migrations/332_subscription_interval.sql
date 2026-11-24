-- 332_subscription_interval — what a subscription costs, and how many editors a team has
-- (issue #641; docs/followups.md § Billing; docs/billing.md § Billing interval and editor count).
--
--   1. subscription.billing_interval: 'month' or 'year', the provider's billing
--      interval, so the plan page can show what a subscription costs (a Team
--      with extra seats, monthly or yearly). Null on rows written before 332,
--      on the staff grant's (330, nothing is billed) and when the provider's
--      interval is neither a plain month nor a plain year. Named
--      billing_interval, not interval, since INTERVAL is a type keyword.
--   2. app_billing_apply, redefined from 327 (its latest), stores the payload's
--      `interval`: absent keeps the stored value (an older sender), null
--      clears it, 'month' or 'year' sets it, anything else is 'invalid'.
--   3. app_account_plan, redefined from 324 (its latest), adds
--      subscription.interval and, for a team account, team.editorCount: the
--      distinct people with editor or owner on the team's projects (team
--      members and admins, and direct editors and owners of its projects),
--      each once; viewers, contributors and farmers hold no seat. Null `team`
--      on a person's account. Same reader gate as before
--      (app_billing_account_readable): only who could read the plan sees the count.
--
-- No new table, policy or grant: subscription's RLS (323) and both functions'
-- grants carry over (CREATE OR REPLACE keeps them). The editor count reads
-- team_member by its primary key (team_id, user_id), project by
-- project_team_idx and project_member by its primary key.

ALTER TABLE subscription ADD COLUMN billing_interval text CHECK (billing_interval IN ('month', 'year'));
COMMENT ON COLUMN subscription.billing_interval IS
	'The provider''s billing interval, month or year (332), from the webhook''s normalised event. Null before 332, for the staff grant, and when the provider''s isn''t a plain month or year.';

-- From 327's definition, with the payload's interval read, checked and stored.
CREATE OR REPLACE FUNCTION app_billing_apply(p_provider text, p_event_id text, p_type text, p_payload jsonb) RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_apply boolean := p_type IN ('subscription.created', 'subscription.updated', 'subscription.deleted');
		v_account uuid;
		v_ref text;
		v_plan text;
		v_status text;
		v_seats integer;
		v_start timestamptz;
		v_end timestamptz;
		v_trial timestamptz;
		v_cancel_at_end boolean;
		v_interval text;
		v_interval_given boolean := false;
		v_created timestamptz;
		v_sub subscription;
		v_outcome text;
		v_iso constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$';
	BEGIN
		-- A system path, like the job tick: never inside a user's or an API key's transaction.
		IF app_current_user_id() IS NOT NULL OR nullif(current_setting('app.current_api_key_id', true), '') IS NOT NULL THEN
			RAISE EXCEPTION 'app_billing_apply runs with no user' USING ERRCODE = 'insufficient_privilege';
		END IF;

		IF p_provider IS NULL OR p_provider NOT IN ('mock', 'manual', 'stripe')
		   OR p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
		   OR p_type IS NULL OR length(p_type) NOT BETWEEN 1 AND 100 THEN
			RETURN 'invalid';
		END IF;

		-- The payload, checked before anything is written (an invalid event is not recorded).
		IF v_apply THEN
			IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
			   OR jsonb_typeof(p_payload -> 'accountId') IS DISTINCT FROM 'string'
			   OR jsonb_typeof(p_payload -> 'externalRef') IS DISTINCT FROM 'string' THEN
				RETURN 'invalid';
			END IF;
			v_ref := p_payload ->> 'externalRef';
			IF length(v_ref) NOT BETWEEN 1 AND 255 OR (p_payload ->> 'accountId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
				RETURN 'invalid';
			END IF;
			v_account := (p_payload ->> 'accountId')::uuid;
			-- The provider's event time (327): absent or null from a sender that has none (mock, manual), else ISO 8601 with an offset.
			IF jsonb_typeof(p_payload -> 'eventCreated') NOT IN ('string', 'null') THEN
				RETURN 'invalid';
			END IF;
			IF (p_payload ->> 'eventCreated') !~ v_iso THEN
				RETURN 'invalid';
			END IF;
			BEGIN
				v_created := (p_payload ->> 'eventCreated')::timestamptz;
			EXCEPTION WHEN data_exception THEN
				RETURN 'invalid';
			END;
			IF p_type <> 'subscription.deleted' THEN
				IF jsonb_typeof(p_payload -> 'planCode') IS DISTINCT FROM 'string'
				   OR jsonb_typeof(p_payload -> 'status') IS DISTINCT FROM 'string'
				   OR jsonb_typeof(p_payload -> 'seats') IS DISTINCT FROM 'number'
				   OR jsonb_typeof(p_payload -> 'periodStart') IS DISTINCT FROM 'string'
				   OR jsonb_typeof(p_payload -> 'periodEnd') IS DISTINCT FROM 'string'
				   OR jsonb_typeof(p_payload -> 'trialEnd') NOT IN ('string', 'null')
				   OR jsonb_typeof(p_payload -> 'cancelAtPeriodEnd') IS DISTINCT FROM 'boolean' THEN
					RETURN 'invalid';
				END IF;
				v_plan := p_payload ->> 'planCode';
				v_status := p_payload ->> 'status';
				IF v_plan NOT IN ('free', 'pro', 'team') OR NOT EXISTS (SELECT 1 FROM plan WHERE code = v_plan)
				   OR v_status NOT IN ('trialing', 'active', 'past_due', 'canceled', 'expired') THEN
					RETURN 'invalid';
				END IF;
				-- ISO 8601 with an offset only: a cast alone takes 'yesterday', 'now' or 'infinity', and a bare time reads in the session's zone.
				IF (p_payload ->> 'periodStart') !~ v_iso OR (p_payload ->> 'periodEnd') !~ v_iso
				   OR (p_payload ->> 'trialEnd') !~ v_iso THEN
					RETURN 'invalid';
				END IF;
				BEGIN
					IF (p_payload ->> 'seats')::numeric <> trunc((p_payload ->> 'seats')::numeric)
					   OR (p_payload ->> 'seats')::numeric NOT BETWEEN 1 AND 100000 THEN
						RETURN 'invalid';
					END IF;
					v_seats := (p_payload ->> 'seats')::integer;
					v_start := (p_payload ->> 'periodStart')::timestamptz;
					v_end := (p_payload ->> 'periodEnd')::timestamptz;
					v_trial := (p_payload ->> 'trialEnd')::timestamptz;
				EXCEPTION WHEN data_exception THEN
					RETURN 'invalid';
				END;
				IF v_end < v_start THEN
					RETURN 'invalid';
				END IF;
				v_cancel_at_end := (p_payload ->> 'cancelAtPeriodEnd')::boolean;
				-- The billing interval (332): absent from an older sender (the stored one is kept), null when the
				-- provider's isn't a plain month or year (a grant, an interval_count past 1), else month or year.
				IF p_payload ? 'interval' THEN
					IF jsonb_typeof(p_payload -> 'interval') = 'null' THEN
						v_interval := NULL;
					ELSIF jsonb_typeof(p_payload -> 'interval') = 'string' AND (p_payload ->> 'interval') IN ('month', 'year') THEN
						v_interval := p_payload ->> 'interval';
					ELSE
						RETURN 'invalid';
					END IF;
					v_interval_given := true;
				END IF;
			END IF;
		ELSIF p_payload IS NOT NULL AND jsonb_typeof(p_payload) = 'object'
		      AND (p_payload ->> 'accountId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
			-- A record-only event names its account when it can; nothing is checked or applied.
			v_account := (p_payload ->> 'accountId')::uuid;
		END IF;

		-- 1. De-duplicate: the first delivery of (provider, event_id) wins.
		INSERT INTO billing_event (provider, event_id, type, outcome) VALUES (p_provider, p_event_id, p_type, 'recorded')
			ON CONFLICT (provider, event_id) DO NOTHING;
		IF NOT FOUND THEN
			RETURN 'duplicate';
		END IF;

		-- Lock the account, so two events for one account apply one after the other (the one-live index stays a backstop).
		IF v_account IS NOT NULL THEN
			PERFORM 1 FROM billing_account WHERE id = v_account FOR UPDATE;
			IF NOT FOUND THEN
				v_account := NULL;
				v_outcome := CASE WHEN v_apply THEN 'unknown_account' ELSE 'recorded' END;
			END IF;
		END IF;

		IF v_outcome IS NULL AND v_apply THEN
			SELECT * INTO v_sub FROM subscription WHERE provider = p_provider AND external_ref = v_ref FOR UPDATE;
			IF v_sub.id IS NOT NULL AND v_sub.billing_account_id <> v_account THEN
				v_outcome := 'conflict';
			ELSIF p_type = 'subscription.deleted' THEN
				IF v_sub.id IS NULL OR v_sub.status IN ('canceled', 'expired') THEN
					v_outcome := 'recorded';
				ELSE
					-- Never stale: a delete is the provider's last word on a subscription, whatever its time.
					UPDATE subscription SET status = 'canceled', cancel_at_period_end = false,
					                        last_event_at = greatest(last_event_at, v_created)
						WHERE id = v_sub.id;
					v_outcome := 'applied';
				END IF;
			ELSIF v_created IS NOT NULL AND v_sub.last_event_at IS NOT NULL AND v_created < v_sub.last_event_at THEN
				-- Older than the event already applied (Stripe doesn't deliver in order): skipped. An equal time applies,
				-- in arrival order, since Stripe's created is whole seconds and two real changes can share one.
				v_outcome := 'stale';
			ELSIF v_sub.status IN ('canceled', 'expired') AND v_status IN ('trialing', 'active', 'past_due') THEN
				-- An ended subscription stays ended (a late or replayed update after its delete).
				v_outcome := 'conflict';
			ELSIF v_status IN ('trialing', 'active', 'past_due') AND EXISTS (
				SELECT 1 FROM subscription
				WHERE billing_account_id = v_account AND status IN ('trialing', 'active', 'past_due')
				  AND id IS DISTINCT FROM v_sub.id
			) THEN
				v_outcome := 'conflict';
			ELSIF v_sub.id IS NULL THEN
				INSERT INTO subscription (billing_account_id, plan_code, status, seats, period_start, period_end, trial_end,
				                          cancel_at_period_end, provider, external_ref, last_event_at, billing_interval)
					VALUES (v_account, v_plan, v_status, v_seats, v_start, v_end, v_trial, v_cancel_at_end, p_provider, v_ref, v_created, v_interval);
				v_outcome := 'applied';
			ELSE
				UPDATE subscription SET plan_code = v_plan, status = v_status, seats = v_seats, period_start = v_start,
				                        period_end = v_end, trial_end = v_trial, cancel_at_period_end = v_cancel_at_end,
				                        last_event_at = greatest(last_event_at, v_created),
				                        billing_interval = CASE WHEN v_interval_given THEN v_interval ELSE billing_interval END
					WHERE id = v_sub.id;
				v_outcome := 'applied';
			END IF;
		END IF;

		v_outcome := coalesce(v_outcome, 'recorded');
		UPDATE billing_event SET outcome = v_outcome, account_id = v_account WHERE provider = p_provider AND event_id = p_event_id;
		RETURN v_outcome;
	END
	$$;

-- From 324's definition, with subscription.interval and team.editorCount.
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
	BEGIN
		IF NOT app_billing_account_readable(p_account) THEN
			RETURN NULL;
		END IF;
		SELECT kind, team_id INTO v_kind, v_team FROM billing_account WHERE id = p_account;
		-- A team's editor seats in use (#641 § Who the plan belongs to): the distinct people with editor or owner
		-- on the team's projects, through the team (member → editor, admin → owner; a team viewer is a viewer)
		-- or as a direct member of one of its projects. Viewers, contributors and farmers hold no seat.
		IF v_kind = 'team' THEN
			SELECT count(*) INTO v_editors FROM (
				SELECT tm.user_id FROM team_member tm
					WHERE tm.team_id = v_team AND tm.role IN ('member', 'admin')
				UNION
				SELECT pm.user_id FROM project p JOIN project_member pm ON pm.project_id = p.id
					WHERE p.team_id = v_team AND pm.role IN ('editor', 'owner')
			) editors;
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
			-- A team account's editor count (332); null on a person's.
			'team', CASE WHEN v_kind = 'team' THEN jsonb_build_object('editorCount', v_editors) END,
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
