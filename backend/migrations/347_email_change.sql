-- 347_email_change — changing an account's email address, re-verified
-- (issue #641 item 5; docs/security.md § Changing the email address).
--
-- POST /auth/change-email (signed in, with the current password) stores one
-- pending change per account here and mails a link to the NEW address; the
-- account's address switches only when that link is used (POST
-- /auth/confirm-email-change), and the old address then gets a notice. Until
-- then nothing about the account changes, and a newer request replaces the
-- pending one (only the newest link works).
--
-- Like email_token (004): only the SHA-256 of the mailed token is stored, the
-- link is single-use (consuming deletes the row) and expires (the route's
-- TTL). The request is made signed in, so issuing goes through the own-row
-- policies; the daily cap reuses 078's account_mail_quota (the shared count,
-- device NULL), which only SECURITY DEFINER code may touch, hence
-- app_issue_email_change. Consuming happens signed out (the link may be opened
-- in another browser), hence app_consume_email_change; the route then acts as
-- the account (tx.ts actAsUser) and updates app_user under its own-row policy,
-- so app_user's unique email is what refuses an address taken in between.

CREATE TABLE email_change (
	-- One pending change per account; the key covers the foreign key.
	user_id    uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
	new_email  citext NOT NULL CHECK (length(new_email) BETWEEN 3 AND 254),
	-- SHA-256 of the token that was mailed. Never the token itself.
	token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE email_change IS
	'A pending change of an account''s email address (347): the new address and the hash of the link mailed to it; deleted when used, replaced by a newer request, gone with the account.';
-- Housekeeping deletes long-dead rows by expiry.
CREATE INDEX email_change_expires_idx ON email_change (expires_at);

ALTER TABLE email_change ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_change_select ON email_change FOR SELECT USING (user_id = app_current_user_id());
CREATE POLICY email_change_insert ON email_change FOR INSERT WITH CHECK (user_id = app_current_user_id());
CREATE POLICY email_change_update ON email_change FOR UPDATE
	USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
CREATE POLICY email_change_delete ON email_change FOR DELETE USING (user_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON email_change TO water_app;

-- Issue a change link for the signed-in account, as 078's
-- app_issue_email_token: refused within p_cooldown of the last request
-- ('cooldown') or once p_cap reset, verification and change emails went out
-- in p_window ('capped'), else the pending change is replaced ('issued').
CREATE FUNCTION app_issue_email_change(
	p_new citext, p_hash bytea, p_ttl interval, p_cooldown interval, p_cap integer, p_window interval
) RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
	BEGIN
		IF v_user IS NULL THEN
			RAISE EXCEPTION 'app_issue_email_change: not allowed' USING ERRCODE = '42501';
		END IF;
		-- The same lock as app_issue_email_token (078): the cap counts all three.
		PERFORM pg_advisory_xact_lock(hashtext('account_mail:' || v_user::text));
		IF EXISTS (SELECT 1 FROM email_change WHERE user_id = v_user AND created_at > now() - p_cooldown) THEN
			RETURN 'cooldown';
		END IF;
		DELETE FROM account_mail_quota WHERE sent_at <= now() - p_window;
		IF (SELECT count(*) FROM account_mail_quota
			WHERE user_id = v_user AND device IS NULL AND sent_at > now() - p_window) >= p_cap THEN
			RETURN 'capped';
		END IF;
		DELETE FROM email_change WHERE user_id = v_user;
		INSERT INTO email_change (user_id, new_email, token_hash, expires_at)
		VALUES (v_user, p_new, p_hash, now() + p_ttl);
		INSERT INTO account_mail_quota (user_id, device) VALUES (v_user, NULL);
		RETURN 'issued';
	END
	$$;
REVOKE ALL ON FUNCTION app_issue_email_change(citext, bytea, interval, interval, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_issue_email_change(citext, bytea, interval, interval, integer, interval) TO water_app;

-- Consume a change link: deletes it (single use) and returns its account and
-- new address, or no row when it is unknown, already used or expired.
CREATE FUNCTION app_consume_email_change(p_hash bytea) RETURNS TABLE (user_id uuid, new_email citext)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid;
		v_new citext;
		v_expires timestamptz;
	BEGIN
		DELETE FROM email_change c WHERE c.token_hash = p_hash
			RETURNING c.user_id, c.new_email, c.expires_at INTO v_user, v_new, v_expires;
		-- Housekeeping: drop long-dead links so the table stays small.
		DELETE FROM email_change c WHERE c.expires_at < now() - interval '7 days';
		IF v_user IS NULL OR v_expires <= now() THEN
			RETURN;
		END IF;
		user_id := v_user;
		new_email := v_new;
		RETURN NEXT;
	END
	$$;
REVOKE ALL ON FUNCTION app_consume_email_change(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_consume_email_change(bytea) TO water_app;
