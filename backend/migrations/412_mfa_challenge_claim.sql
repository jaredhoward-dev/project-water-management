-- 412_mfa_challenge_claim — a sign-in challenge is used up exactly once
-- (docs/security.md § Two-step sign-in).
--
-- POST /auth/mfa/verify trades the `wm_mfa` challenge cookie and a code for a
-- session, and records the challenge's id in revoked_session (102) so it is
-- good once. It recorded it through app_revoke_session, which answers nothing
-- and ignores an id already recorded (ON CONFLICT DO NOTHING). Two requests
-- with the same challenge at the same moment, each with a different right
-- code (an app code and a recovery code, say), both passed the challenge
-- check before either committed, and both got a session.
--
-- app_claim_session records the id the same way and says whether this call
-- is the one that recorded it. A second claimant's insert waits on the first
-- one's uncommitted key, then inserts nothing and gets false: the route rolls
-- its transaction back (the code it spent included) and refuses. Only the
-- signed-in account's own ids, as app_revoke_session.
CREATE FUNCTION app_claim_session(p_jti uuid, p_expires timestamptz) RETURNS boolean
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_claimed boolean;
	BEGIN
		IF app_current_user_id() IS NULL OR p_jti IS NULL OR p_expires IS NULL THEN
			RAISE EXCEPTION 'app_claim_session: not allowed' USING ERRCODE = '42501';
		END IF;
		DELETE FROM revoked_session WHERE expires_at <= now();
		INSERT INTO revoked_session (user_id, jti, expires_at) VALUES (app_current_user_id(), p_jti, p_expires)
			ON CONFLICT (user_id, jti) DO NOTHING
			RETURNING true INTO v_claimed;
		RETURN coalesce(v_claimed, false);
	END
	$$;
REVOKE ALL ON FUNCTION app_claim_session(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_claim_session(uuid, timestamptz) TO water_app;
