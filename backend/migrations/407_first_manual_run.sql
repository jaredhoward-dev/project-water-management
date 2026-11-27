-- 407: an owner-only record of each person's first manual run, for the
-- activation metric (issue #939 item 1; docs/billing.md § Metrics and the
-- abuse report; docs/security.md § Personal information).
--
-- 402's billing_metrics_people took a person's first run as min(created_at)
-- over the manual model_run rows still stored. Runs go: the per-project run
-- cap trims the oldest, a person deletes a run, a project is deleted with its
-- runs. So a person who ran a model within 7 days of signing up and whose
-- runs were trimmed or deleted since stopped counting as activated.
--
--   1. first_manual_run: one row per person, ever, holding when their first
--      manual run (model_run.trigger = 'manual', a run a person asked for)
--      was saved. Written by an AFTER INSERT trigger on model_run
--      (first_manual_run_record, SECURITY DEFINER), ON CONFLICT DO NOTHING,
--      so later runs never move it and deleting runs never removes it.
--      Owner only: RLS on, no policy, no privilege for water_app. The
--      activation metric and the person's own data export read it, both
--      through definer functions.
--   2. Backfilled from the manual runs stored today (the best we have for
--      runs already deleted).
--   3. Personal information (a timestamp of a person's activity, keyed to
--      them): in "Download my data" as firstManualRun through
--      app_subject_first_manual_run() (the caller's own row only, no user
--      argument, as 396's readers), and deleted with the account
--      (ON DELETE CASCADE from app_user).
--   4. billing_metrics_people, from its latest definition (402), reads
--      first_run_at from the record instead of the stored runs. Same
--      signature, so CREATE OR REPLACE keeps the owner-only grants.

-- ---------------------------------------------------------------------------
-- 1. The record
-- ---------------------------------------------------------------------------
CREATE TABLE first_manual_run (
	user_id      uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
	first_run_at timestamptz NOT NULL
);
COMMENT ON TABLE first_manual_run IS
	'When each person''s first manual run was saved (407, issue #939): the activation metric''s first run, kept when runs are trimmed or deleted. Owner only; written by the model_run trigger; in the person''s data export; goes with the account.';
ALTER TABLE first_manual_run ENABLE ROW LEVEL SECURITY;
-- No policy and no grant: only the definer trigger, the export reader and the owner's metrics touch it.
REVOKE ALL ON first_manual_run FROM PUBLIC, water_app;

CREATE FUNCTION first_manual_run_record() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		INSERT INTO first_manual_run (user_id, first_run_at) VALUES (NEW.created_by, NEW.created_at)
			ON CONFLICT (user_id) DO NOTHING;
		RETURN NULL;
	END
	$$;
REVOKE ALL ON FUNCTION first_manual_run_record() FROM PUBLIC, water_app;

CREATE TRIGGER model_run_first_manual_run AFTER INSERT ON model_run
	FOR EACH ROW WHEN (NEW.trigger = 'manual' AND NEW.created_by IS NOT NULL)
	EXECUTE FUNCTION first_manual_run_record();

-- ---------------------------------------------------------------------------
-- 2. Backfill
-- ---------------------------------------------------------------------------
INSERT INTO first_manual_run (user_id, first_run_at)
SELECT r.created_by, min(r.created_at) FROM model_run r
WHERE r.trigger = 'manual' AND r.created_by IS NOT NULL
GROUP BY r.created_by
ON CONFLICT (user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. The export's reader: the caller's own row, or null
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_subject_first_manual_run() RETURNS jsonb
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	SELECT jsonb_build_object('firstRunAt', f.first_run_at)
	FROM first_manual_run f
	WHERE app_current_user_id() IS NOT NULL AND f.user_id = app_current_user_id()
	$$;
COMMENT ON FUNCTION app_subject_first_manual_run() IS
	'The signed-in person''s first_manual_run row (407) for the data export; null when there is none.';
REVOKE ALL ON FUNCTION app_subject_first_manual_run() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_subject_first_manual_run() TO water_app;

-- ---------------------------------------------------------------------------
-- 4. The activation metric reads the record (402's definition otherwise)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing_metrics_people(p_month date) RETURNS TABLE (
	user_id uuid,
	email text,
	created_at timestamptz,
	verified boolean,
	first_run_at timestamptz,
	in_month boolean,
	signup_day date
)
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT
			u.id,
			u.email::text,
			u.created_at,
			u.email_verified_at IS NOT NULL,
			(SELECT f.first_run_at FROM first_manual_run f WHERE f.user_id = u.id),
			date_trunc('month', u.created_at AT TIME ZONE 'Africa/Johannesburg')::date = date_trunc('month', p_month)::date,
			(u.created_at AT TIME ZONE 'Africa/Johannesburg')::date
		FROM app_user u
	$$;
REVOKE ALL ON FUNCTION billing_metrics_people(date) FROM PUBLIC, water_app;
COMMENT ON FUNCTION billing_metrics_people(date) IS
	'Owner only (325, 402, 407, issue #641): every person''s sign-up, verification and first manual run (first_manual_run, kept when runs are deleted), for pnpm dev:billing:report''s activation and abuse signals.';
