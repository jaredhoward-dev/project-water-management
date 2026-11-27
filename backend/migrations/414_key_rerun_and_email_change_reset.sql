-- 414_key_rerun_and_email_change_reset — two loose ends the 2026-11-27 sweep
-- of the public endpoints found (docs/security.md § API keys, § Two-step
-- sign-in → Recovery).
--
-- Expand-only: no table or column changes. Every object below starts from its
-- latest definition, named at it.
--
--  1. app_rerun_acting_user (latest: 042). An API key's ingest queued the
--     project's automatic re-run as the key's creator whoever they now were.
--     A creator whose account was deleted (created_by NULL) already had
--     nobody to run as, and app_enqueue_rerun (latest: 341) skips the re-run
--     then. But a creator who was only removed from the project, or demoted
--     below editor, was still named: a job was queued as someone the runner
--     refuses (jobs/runner.ts: "no longer has the editor role"), so every push
--     made a job bound to die, and the key's answer reported a
--     `rerunQueuedFor` time for a run that would never happen. Now the
--     creator is named only while they hold editor or above on the project
--     (alert_user_role, 051: the same direct-or-team role app_project_role
--     answers for the signed-in user), so a removed or demoted creator takes
--     the deleted creator's clean skip: no job, `rerunQueuedFor: null`, and
--     the ingest still commits. Still a plain (not SECURITY DEFINER)
--     function: its callers are app_enqueue_rerun and the auto-calibration's
--     enqueue (108), both SECURITY DEFINER, so it reads api_key and the
--     memberships as their owner.
--
--  2. app_mfa_reset_end_unconfirmed() (new). A confirmation link for a
--     second-factor reset (205) is mailed to the account's address. When the
--     address then changes (POST /auth/confirm-email-change, 347), every
--     other link mailed to the old address dies with it (email_token), but
--     an unconfirmed reset's link did not: whoever kept the old inbox could
--     still start the account's 3-day factor removal. The route now calls
--     this, as the account (actAsUser), in the same transaction: it ends the
--     caller's own unconfirmed reset ('unconfirmed', as a lapsed or replaced
--     link ends), and leaves a confirmed one waiting (its emails go to the
--     account's current address, and a code still cancels it). SECURITY
--     DEFINER (mfa_reset has no UPDATE grant or policy for water_app), pinned
--     search_path, refused without a signed-in user, EXECUTE to water_app only.

-- 1. From 042_auto_rerun.sql.
CREATE OR REPLACE FUNCTION app_rerun_acting_user(p_project uuid) RETURNS uuid
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT CASE
			WHEN app_current_user_id() IS NOT NULL THEN CASE WHEN app_has_role(p_project, 'editor') THEN app_current_user_id() END
			WHEN app_api_key_project('series:write') = p_project THEN (
				SELECT k.created_by FROM api_key k
				WHERE k.id = app_current_api_key_id()
				  AND k.created_by IS NOT NULL
				  AND alert_user_role(p_project, k.created_by) >= 'editor'
			)
		END
	$$;

-- 2. New: the caller's own unconfirmed second-factor reset ends. True when one did.
CREATE FUNCTION app_mfa_reset_end_unconfirmed() RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v_ended integer;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'app_mfa_reset_end_unconfirmed: not allowed' USING ERRCODE = '42501';
		END IF;
		UPDATE mfa_reset SET ended_at = now(), end_reason = 'unconfirmed', confirm_hash = NULL
		WHERE user_id = uid AND ended_at IS NULL AND confirmed_at IS NULL;
		GET DIAGNOSTICS v_ended = ROW_COUNT;
		RETURN v_ended > 0;
	END
	$$;
REVOKE ALL ON FUNCTION app_mfa_reset_end_unconfirmed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mfa_reset_end_unconfirmed() TO water_app;
