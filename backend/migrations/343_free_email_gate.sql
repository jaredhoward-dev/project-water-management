-- 343_free_email_gate — whether Free's verified-email gate applies to the
-- caller on a project (issue #641 § Free tier and abuse: "the assistant and
-- live feeds need a verified email"; docs/billing.md § Verified email on Free).
--
-- app_free_email_gate(project) answers, for the signed-in person:
--   * NULL when the gate doesn't apply: billing isn't enforced (the
--     transaction's app.billing_enforced, set by db/tx.ts from
--     BILLING_ENFORCED, isn't 'on'), the caller isn't a member of the project,
--     the project has no billing account (its creator's account deleted, never
--     refused, as 338), or the account has a live subscription
--     (trialing, active or past_due: 338's test, so a paid or trialing account
--     is never gated);
--   * else the caller's own {"email", "verified"}, which the route judges:
--     unverified, or a disposable domain (auth/disposable.ts, in TypeScript),
--     is refused.
-- The plan is read here because app_entitlements and app_account_plan answer
-- NULL below editor, and a viewer may start an assistant turn. Nothing about
-- the account leaks: a non-member gets NULL, and a member learns only that the
-- project is on Free, with their own address.
--
-- No table, policy or grant beyond EXECUTE to water_app; reads app_user by its
-- key and subscription by billing_account_id (323's subscription_account_idx).

CREATE FUNCTION app_free_email_gate(p_project uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_me uuid := app_current_user_id();
		v_account uuid;
		v_out jsonb;
	BEGIN
		IF v_me IS NULL OR p_project IS NULL
		   OR coalesce(current_setting('app.billing_enforced', true), '') <> 'on'
		   OR app_project_role(p_project) IS NULL THEN
			RETURN NULL;
		END IF;
		SELECT billing_account_id INTO v_account FROM project WHERE id = p_project;
		IF v_account IS NULL OR EXISTS (
			SELECT 1 FROM subscription s
			WHERE s.billing_account_id = v_account AND s.status IN ('trialing', 'active', 'past_due')) THEN
			RETURN NULL;
		END IF;
		SELECT jsonb_build_object('email', u.email, 'verified', u.email_verified_at IS NOT NULL) INTO v_out
		FROM app_user u WHERE u.id = v_me;
		RETURN v_out;
	END
	$$;
REVOKE ALL ON FUNCTION app_free_email_gate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_free_email_gate(uuid) TO water_app;
COMMENT ON FUNCTION app_free_email_gate(uuid) IS
	'Free''s verified-email gate (343, issue #641): NULL unless billing is enforced and the caller is a member of a project on Free; else the caller''s own email and whether it is verified.';
