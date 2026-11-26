-- 401: the reverse trial's claim follows the person to a new address, and
-- the staff revoke takes the billing lock before the grant's row.
--
-- 1. The claim follows the address.
--
-- reverse_trial_claim (342) keeps one SHA-256 per canonical address that has
-- had the trial, and app_reverse_trial_start (397) claims the caller's own
-- address at the time. An account that had its trial on a@ and then moved to
-- b@ (POST /auth/confirm-email-change, which keeps the account verified) left
-- b@ unclaimed: deleting the account and signing up again with b@ started a
-- second trial for the same person, which #641's "once per canonical email"
-- and 342's "deleting and signing up again gets no second trial" rule out.
--
-- So whenever app_user.email changes and the old address's canonical form is
-- claimed, the new one's is claimed too (same hash, no address, no link to the
-- account, as 342). A trigger rather than the route, so every path that
-- rewrites an address (the confirm route, the schema owner by hand) does it.
-- An address change on an account whose old address was never claimed (no
-- trial, or never verified) claims nothing: that person still has their one
-- trial. A claim is never removed, so nothing here can give a trial back.
--
-- 2. app_staff_revoke_grant, from its latest definition (330; nothing since
--    replaced it), takes 334's billing lock (an advisory lock on 'billing:' ||
--    account) and the account row before it locks the grant FOR UPDATE, as
--    app_billing_apply (344), 342/397, 374 and the expiry ticks (387) do.
--    Before, it locked the grant's row first and met the billing lock only in
--    341's sync on its UPDATE; a paid invoice's webhook holds the billing lock
--    and locks the live grant's row FOR UPDATE (344), so an operator revoking
--    while that invoice landed deadlocked (expireLockOrder.db.test.ts).
--    Nothing else changed.
--
-- Started from the latest definitions: canonical_email (397), reverse_trial_claim (342),
-- app_staff_revoke_grant (330).

-- ---------------------------------------------------------------------------
-- 1. The claim follows the address
-- ---------------------------------------------------------------------------

CREATE FUNCTION reverse_trial_claim_follow_email() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF EXISTS (SELECT 1 FROM reverse_trial_claim WHERE email_hash = sha256(convert_to(canonical_email(OLD.email::text), 'UTF8'))) THEN
			INSERT INTO reverse_trial_claim (email_hash)
			VALUES (sha256(convert_to(canonical_email(NEW.email::text), 'UTF8')))
			ON CONFLICT (email_hash) DO NOTHING;
		END IF;
		RETURN NULL;
	END
	$$;
COMMENT ON FUNCTION reverse_trial_claim_follow_email() IS
	'app_user email trigger (401): when the old address''s canonical form has had the reverse trial, claim the new one''s too, so changing the address and then deleting and signing up again gives no second trial.';
REVOKE ALL ON FUNCTION reverse_trial_claim_follow_email() FROM PUBLIC;

CREATE TRIGGER app_user_reverse_trial_claim_follow
	AFTER UPDATE OF email ON app_user
	FOR EACH ROW
	WHEN (canonical_email(OLD.email::text) IS DISTINCT FROM canonical_email(NEW.email::text))
	EXECUTE FUNCTION reverse_trial_claim_follow_email();

-- ---------------------------------------------------------------------------
-- 2. app_staff_revoke_grant: the billing lock first
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_staff_revoke_grant(p_account uuid, p_reason text, p_by text) RETURNS uuid
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		v_reason text := btrim(coalesce(p_reason, ''));
		v_by text := btrim(coalesce(p_by, ''));
		v_live subscription;
	BEGIN
		IF length(v_reason) NOT BETWEEN 1 AND 500 THEN
			RAISE EXCEPTION 'give a reason (at most 500 characters)' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF length(v_by) NOT BETWEEN 1 AND 100 THEN
			RAISE EXCEPTION 'say who revokes it (at most 100 characters)' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		-- 334's lock, then the account row, before the grant's row: the UPDATE below fires 341's sync, which takes it.
		PERFORM pg_advisory_xact_lock(hashtext('billing:' || p_account::text));
		PERFORM 1 FROM billing_account WHERE id = p_account FOR UPDATE;
		SELECT * INTO v_live FROM subscription
			WHERE billing_account_id = p_account AND provider = 'manual' AND status = 'active'
			FOR UPDATE;
		IF v_live.id IS NULL THEN
			RAISE EXCEPTION 'the account has no live staff grant' USING ERRCODE = 'no_data_found';
		END IF;
		UPDATE subscription SET status = 'canceled', period_end = greatest(coalesce(period_start, now()), now()), cancel_at_period_end = false
			WHERE id = v_live.id;
		INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
		VALUES (p_account, v_live.id, 'revoke', v_live.plan_code, now(), v_reason, v_by);
		RETURN v_live.id;
	END
	$$;
REVOKE ALL ON FUNCTION app_staff_revoke_grant(uuid, text, text) FROM PUBLIC, water_app;
