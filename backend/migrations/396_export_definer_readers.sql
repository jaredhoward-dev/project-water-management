-- 396: the data export's definer readers (issue #906, after #876's audit).
--
-- "Download my data" (GET /auth/me/export, auth/export.ts) read some of the
-- person's rows under RLS, so they dropped out when RLS stopped showing them,
-- and one table it couldn't read at all. Three SECURITY DEFINER readers, each
-- with no user argument and returning only the caller's own rows
-- (app_current_user_id()), as app_subject_export (054) and
-- app_subject_participation (166) do:
--
--   1. app_subject_reverse_trial(): the caller's reverse_trial_claim row (342),
--      the hash (hex) and when, or null. The claim holds no account, so the row
--      is found the way it is written: SHA-256 of the canonical form of the
--      caller's *current* address (billing/metrics.ts canonicalEmail, mirrored
--      by canonical_email below; reverseTrial.ts reverseTrialHash). It never
--      takes a hash from the caller, so it is no oracle for anyone else's
--      address. A claim made under an address the person has since changed
--      isn't found: nothing links it to them any more.
--   2. app_subject_scenario_memberships(): the caller's scenario_member rows
--      (045, 115), read past RLS. Under RLS (scenario_member_select is
--      app_scenario_readable) a member reads their row while their role is
--      contributor or above, and a drop below that deletes the share (049
--      project_member_prune_shares), so today the two agree; the reader keeps
--      the export independent of who may read the application, so a future
--      narrowing of that policy can't hide a row that stands.
--   3. app_subject_scenarios(): the scenarios the caller owns
--      (scenario.owner_user_id): their licence applications ('applicant') and
--      their modelling scenarios ('team'), as metadata (name, status, outcome,
--      dates), never the ops or the description, which are the project's
--      model record. An applicant whose role drops below contributor no longer
--      reads their own draft under RLS (app_scenario_visible), yet it stands,
--      as it does after they leave the project; so read past RLS.
--
-- canonical_email(text) is the SQL twin of canonicalEmail: lower-cased and
-- trimmed, `+tag` dropped (not a leading `+`), googlemail.com as gmail.com,
-- Gmail's dots dropped. export.db.test.ts checks it against reverseTrialHash.
-- It is IMMUTABLE and not SECURITY DEFINER (a pure string function).

CREATE FUNCTION canonical_email(p_email text) RETURNS text
	LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog
	AS $$
	DECLARE
		v text := lower(btrim(p_email, E' \t\n\r\f\v'));
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
	'The canonical form of an address, as billing/metrics.ts canonicalEmail (396): lower-cased, trimmed, +tag dropped, googlemail.com as gmail.com, Gmail''s dots dropped. reverse_trial_claim keeps its SHA-256.';
REVOKE ALL ON FUNCTION canonical_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION canonical_email(text) TO water_app;

-- 1. The caller's reverse-trial claim
CREATE FUNCTION app_subject_reverse_trial() RETURNS jsonb
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	SELECT jsonb_build_object('emailHash', encode(c.email_hash, 'hex'), 'claimedAt', c.claimed_at)
	FROM app_user u
	JOIN reverse_trial_claim c ON c.email_hash = sha256(convert_to(canonical_email(u.email::text), 'UTF8'))
	WHERE app_current_user_id() IS NOT NULL AND u.id = app_current_user_id()
	$$;
COMMENT ON FUNCTION app_subject_reverse_trial() IS
	'The signed-in person''s reverse_trial_claim (342), found by the SHA-256 of their current canonical address, for the data export (396); null when there is none. Takes no hash, so it tests no one else''s address.';
REVOKE ALL ON FUNCTION app_subject_reverse_trial() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_subject_reverse_trial() TO water_app;

-- 2. The caller's scenario memberships, whatever their role now
CREATE FUNCTION app_subject_scenario_memberships() RETURNS jsonb
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	SELECT coalesce(jsonb_agg(jsonb_build_object(
		'scenarioId', sm.scenario_id,
		'projectId', sm.project_id,
		'projectName', p.name,
		'scenarioName', s.name,
		'addedAt', sm.added_at,
		'addedBy', a.display_name
	) ORDER BY sm.added_at, sm.scenario_id), '[]'::jsonb)
	FROM scenario_member sm
	LEFT JOIN scenario s ON s.id = sm.scenario_id
	LEFT JOIN project p ON p.id = sm.project_id
	LEFT JOIN app_user a ON a.id = sm.added_by
	WHERE app_current_user_id() IS NOT NULL AND sm.user_id = app_current_user_id()
	$$;
COMMENT ON FUNCTION app_subject_scenario_memberships() IS
	'The signed-in person''s own scenario_member rows (the applications they were added to), whatever their role now, for the data export (396).';
REVOKE ALL ON FUNCTION app_subject_scenario_memberships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_subject_scenario_memberships() TO water_app;

-- 3. The scenarios the caller owns, as metadata
CREATE FUNCTION app_subject_scenarios() RETURNS jsonb
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	SELECT coalesce(jsonb_agg(jsonb_build_object(
		'scenarioId', s.id,
		'projectId', s.project_id,
		'projectName', p.name,
		'name', s.name,
		'origin', s.origin,
		'status', s.status,
		'outcome', s.outcome,
		'createdAt', s.created_at,
		'submittedAt', s.submitted_at,
		'decidedAt', s.decided_at
	) ORDER BY s.created_at, s.id), '[]'::jsonb)
	FROM scenario s
	LEFT JOIN project p ON p.id = s.project_id
	WHERE app_current_user_id() IS NOT NULL AND s.owner_user_id = app_current_user_id()
	$$;
COMMENT ON FUNCTION app_subject_scenarios() IS
	'The scenarios the signed-in person owns (licence applications and modelling scenarios), as metadata only (no ops, no description), for the data export (396).';
REVOKE ALL ON FUNCTION app_subject_scenarios() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_subject_scenarios() TO water_app;
