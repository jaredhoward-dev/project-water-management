-- 333_billing_subscription_ref — which provider holds an account's live
-- subscription, and under which id (issue #641 Phase 5, changing a Team's
-- seats; docs/billing.md § Changing a Team's seats).
--
-- POST /teams/:id/plan/seats changes the extra-seat item on the provider's
-- subscription, so it needs that subscription's id (Stripe's sub_…), and it
-- refuses a staff grant (provider 'manual': a grant's seats change by a new
-- grant). app_account_plan answers neither, and stays as it is.
--
--   app_billing_live_subscription_ref(account): { provider, externalRef }
--   of the account's live (trialing, active, past_due) subscription, NULL
--   when there is none or the caller isn't the account's person or an admin
--   of its team (app_billing_account_readable, 323), as 328's
--   app_billing_customer_ref. Read-only: the seats themselves are written
--   only by the webhook (app_billing_apply, 326/327) and the grant (330).

CREATE FUNCTION app_billing_live_subscription_ref(p_account uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT app_billing_account_readable(p_account) THEN
			RETURN NULL;
		END IF;
		RETURN (SELECT jsonb_build_object('provider', s.provider, 'externalRef', s.external_ref)
			FROM subscription s
			WHERE s.billing_account_id = p_account AND s.status IN ('trialing', 'active', 'past_due')
			LIMIT 1);
	END
	$$;
REVOKE ALL ON FUNCTION app_billing_live_subscription_ref(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_billing_live_subscription_ref(uuid) TO water_app;
COMMENT ON FUNCTION app_billing_live_subscription_ref(uuid) IS
	'The provider and external id of the account''s live subscription, for its person or a team admin only (333, issue #641: changing a Team''s seats).';
