-- 397: the reverse trial hashes the caller's own address (issue #914), and
-- canonical_email lower-cases ASCII only, as canonicalEmail now does.
--
--   1. canonical_email(text), from its latest definition (396): `lower()`
--      became an ASCII-only fold (A-Z to a-z, translate()), and nothing else
--      changed. Postgres's lower() follows the database's locale and Unicode
--      tables, JavaScript's toLowerCase() its own: they differ on non-ASCII
--      letters (`İ` is `i` in one and `i` + U+0307 in the other), so the
--      backend and the database could hash one address two ways.
--      billing/metrics.ts canonicalEmail folds A-Z only too, and trims only the
--      same six ASCII whitespace characters (String.trim() also strips
--      Unicode spaces); a non-ASCII letter stays as written on both sides.
--      export.db.test.ts checks the pair on ASCII and non-ASCII addresses.
--      Claims stored before this: none in production (the trial is off,
--      REVERSE_TRIAL unset), and an ASCII address hashes as before.
--   2. app_reverse_trial_start(), new, with no argument: 342's function, from
--      its latest definition (342; nothing since replaced it), except that it
--      reads the caller's own address (app_user.email, with its verified check)
--      and claims SHA-256(canonical_email(address)) itself, as
--      app_subject_reverse_trial (396) finds the claim. 342 took the hash from
--      its caller and checked only its shape, so a direct caller could have
--      used up any other address's one trial; now no caller names an address.
--   3. app_reverse_trial_start(text), 342's signature, kept for a backend
--      still on the old code while a release rolls out (migrations run before
--      the new Lambda code is live): it ignores the hash it is given and
--      starts the caller's own trial through (2), so an old backend's call
--      behaves exactly as before for its own address and can't claim another.
--      SECURITY INVOKER now: it runs nothing itself. A later migration drops
--      it once every deployed backend calls (2) (billing/reverseTrial.ts).
--
-- Started from the latest definitions: canonical_email (396),
-- app_reverse_trial_start(text) (342).

-- ---------------------------------------------------------------------------
-- 1. canonical_email: ASCII-only lower-casing
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION canonical_email(p_email text) RETURNS text
	LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog
	AS $$
	DECLARE
		v text := translate(btrim(p_email, E' \t\n\r\f\v'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
		r int := strpos(reverse(v), '@');
		v_at int;
		v_local text;
		v_domain text;
		v_plus int;
	BEGIN
		IF r = 0 THEN
			RETURN v;
		END IF;
		v_at := length(v) - r + 1; -- the last '@', 1-based
		IF v_at <= 1 THEN
			RETURN v;
		END IF;
		v_local := substr(v, 1, v_at - 1);
		v_domain := substr(v, v_at + 1);
		v_plus := strpos(v_local, '+');
		IF v_plus > 1 THEN
			v_local := substr(v_local, 1, v_plus - 1);
		END IF;
		IF v_domain = 'googlemail.com' THEN
			v_domain := 'gmail.com';
		END IF;
		IF v_domain = 'gmail.com' THEN
			v_local := replace(v_local, '.', '');
		END IF;
		RETURN v_local || '@' || v_domain;
	END
	$$;
COMMENT ON FUNCTION canonical_email(text) IS
	'The canonical form of an address, as billing/metrics.ts canonicalEmail (396, 397): ASCII whitespace trimmed, A-Z lower-cased (ASCII only, so it agrees with JavaScript), +tag dropped, googlemail.com as gmail.com, Gmail''s dots dropped. reverse_trial_claim keeps its SHA-256.';
REVOKE ALL ON FUNCTION canonical_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION canonical_email(text) TO water_app;

-- ---------------------------------------------------------------------------
-- 2. app_reverse_trial_start(): the caller's own address, hashed here
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_reverse_trial_start() RETURNS text
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_verified boolean;
		v_email text;
		v_account uuid;
		v_days integer;
		v_end timestamptz;
		v_id uuid;
	BEGIN
		IF v_user IS NULL THEN
			RAISE EXCEPTION 'app_reverse_trial_start: not allowed' USING ERRCODE = '42501';
		END IF;
		SELECT email_verified_at IS NOT NULL, email::text INTO v_verified, v_email FROM app_user WHERE id = v_user;
		IF NOT coalesce(v_verified, false) THEN
			RETURN 'unverified';
		END IF;
		SELECT trial_days INTO v_days FROM plan WHERE code = 'pro';
		IF coalesce(v_days, 0) < 1 THEN
			RAISE EXCEPTION 'app_reverse_trial_start: plan pro has no trial_days' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		v_account := billing_account_ensure('user', v_user);
		-- One start at a time per account, against a concurrent grant or webhook (the one-live index is the backstop).
		-- 334's lock first, before the row lock: the subscription INSERT below fires 341's sync, which takes it,
		-- and taking it after FOR UPDATE would deadlock against a sync that holds it and writes the row.
		PERFORM pg_advisory_xact_lock(hashtext('billing:' || v_account::text));
		PERFORM 1 FROM billing_account WHERE id = v_account FOR UPDATE;
		IF EXISTS (SELECT 1 FROM subscription WHERE billing_account_id = v_account AND status IN ('trialing', 'active', 'past_due')) THEN
			RETURN 'live';
		END IF;
		-- The claim is the caller's own canonical address, as app_subject_reverse_trial (396) finds it.
		INSERT INTO reverse_trial_claim (email_hash) VALUES (sha256(convert_to(canonical_email(v_email), 'UTF8'))) ON CONFLICT (email_hash) DO NOTHING;
		IF NOT FOUND THEN
			RETURN 'claimed';
		END IF;
		v_end := now() + make_interval(days => v_days);
		INSERT INTO subscription (billing_account_id, plan_code, status, period_start, period_end, trial_end, cancel_at_period_end, provider)
		VALUES (v_account, 'pro', 'trialing', now(), v_end, v_end, true, 'manual')
		RETURNING id INTO v_id;
		INSERT INTO billing_grant_log (billing_account_id, subscription_id, action, plan_code, until, reason, granted_by)
		VALUES (v_account, v_id, 'grant', 'pro', v_end, 'the ' || v_days || '-day Pro trial for a newly verified person', 'reverse trial');
		RETURN 'started';
	END
	$$;
COMMENT ON FUNCTION app_reverse_trial_start() IS
	'Start the signed-in person''s 14-day Pro reverse trial (342, 397): unverified, live, claimed or started. The claim is the SHA-256 of canonical_email of the caller''s own current address, worked out here; no caller names an address.';
REVOKE ALL ON FUNCTION app_reverse_trial_start() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_reverse_trial_start() TO water_app;

-- ---------------------------------------------------------------------------
-- 3. app_reverse_trial_start(text): 342's signature, its hash ignored
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_reverse_trial_start(p_email_hash text) RETURNS text
	LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public
	AS $$ SELECT app_reverse_trial_start() $$;
COMMENT ON FUNCTION app_reverse_trial_start(text) IS
	'342''s signature, kept for a backend on the old code during a release (397): ignores the hash and starts the caller''s own trial through app_reverse_trial_start(). Dropped once every backend calls that.';
REVOKE ALL ON FUNCTION app_reverse_trial_start(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_reverse_trial_start(text) TO water_app;
