-- 365_decision_log_cap_runs — the season decision log gives a reader kept
-- from the registered volumes no per-farm figures of a cap or
-- full-allocation run (issue #523 finding I; docs/security.md § Allocations).
--
-- Before 213 a baseline could cap use at, or scale demand to, each farm's
-- registered volume, so such a run's farm figures are worked out from the
-- volumes. The API refuses to publish one now and withholds an older one's
-- farm previews and outlook from such a reader (farms/view.ts,
-- verdictsOnly.ts), but each publication's `publication.published` audit
-- event (the decision log, publish/decision.ts) keeps every farm's figures
-- (`perFarm`: demand, supply, share, short days, dam level, band), and a
-- viewer reads the audit log's subjects in the History through
-- app_audit_subject (190, 231), which passed them unchanged.
--
-- Now app_audit_subject drops `perFarm` from a `publication.published`
-- subject (its `farms` count stays, as verdictsOnly's counts do) for a reader
-- who doesn't read each allocation row (app_reads_allocation_units, 231)
-- when its run held to the volumes: the run, still kept, ran in cap or
-- fullAllocation mode (summary.allocations.mode, what farms/view.ts reads);
-- or the run is gone (trimmed by the run cap) and the event was recorded
-- before 213 was applied here, or when can't be told. A trimmed run's mode
-- is unknowable, and only a publication from before 213 can be a cap run, so
-- a later one's figures stay readable.
--
-- Expand only: a new four-argument app_audit_subject takes the event's
-- created_at; the three-argument one the running code calls stays, now
-- calling it with no time (a trimmed run's figures withheld), until the code
-- that passes created_at is deployed. Latest definition: 231.
--
-- app_audit_run_held_to_volumes is SECURITY DEFINER: it reads the run's
-- summary and the migration ledger (schema_migrations, the runner's own
-- table) as the owner, only for a viewer or above of the project who is kept
-- from the volumes, and answers a boolean only. Who is kept from them is
-- app_reads_allocation_units's to say (231, the one place that decides): both
-- functions call it and neither reads the viewers' switch or ranks a role.

CREATE FUNCTION app_audit_run_held_to_volumes(p_project uuid, p_subject jsonb, p_at timestamptz) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		run_id uuid;
		mode text;
		cutoff timestamptz;
	BEGIN
		-- Nothing for anyone below a viewer, and nothing to withhold from a reader of each volume.
		IF NOT coalesce(app_has_role(p_project, 'viewer'), false) OR app_reads_allocation_units(p_project) THEN
			RETURN false;
		END IF;
		IF p_subject ->> 'runId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
			run_id := (p_subject ->> 'runId')::uuid;
			SELECT r.summary -> 'allocations' ->> 'mode' INTO mode FROM model_run r WHERE r.id = run_id AND r.project_id = p_project;
			IF FOUND THEN
				RETURN coalesce(mode IN ('cap', 'fullAllocation'), false);
			END IF;
		END IF;
		-- The run is gone (or the subject names none): withheld unless the event is known to be from after 213.
		SELECT m.applied_at INTO cutoff FROM schema_migrations m WHERE m.name = '213_baseline_allocation_compare_only.sql';
		RETURN p_at IS NULL OR cutoff IS NULL OR p_at < cutoff;
	END
	$$;
COMMENT ON FUNCTION app_audit_run_held_to_volumes(uuid, jsonb, timestamptz) IS
	'Whether the run a publication.published subject names held farms to their registered volumes, for a reader kept from them (365, #523 I): kept and ran in cap or fullAllocation mode; or gone, and the event (p_at) is from before 213 was applied, or that can''t be told. False for anyone below a viewer of the project and for anyone who reads each volume (app_reads_allocation_units). app_audit_subject reads it.';
REVOKE ALL ON FUNCTION app_audit_run_held_to_volumes(uuid, jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_audit_run_held_to_volumes(uuid, jsonb, timestamptz) TO water_app;

CREATE FUNCTION app_audit_subject(p_project uuid, p_kind text, p_subject jsonb, p_at timestamptz) RETURNS jsonb
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT CASE
			WHEN p_kind LIKE 'allocation.%' AND NOT app_reads_allocation_units(p_project)
			THEN p_subject - 'registrationNo' - 'volumeM3PerYear'
			WHEN p_kind = 'publication.published' AND p_subject ? 'perFarm'
				AND NOT app_reads_allocation_units(p_project)
				AND app_audit_run_held_to_volumes(p_project, p_subject, p_at)
			THEN p_subject - 'perFarm'
			ELSE p_subject
		END
	$$;
COMMENT ON FUNCTION app_audit_subject(uuid, text, jsonb, timestamptz) IS
	'An audit event''s subject as the current user may read it (190, 231, 365), p_at the event''s created_at: for a reader who can''t read the allocation rows themselves (app_reads_allocation_units), an allocation event without its registration number or volume, and a publication of a run that held farms to their volumes (app_audit_run_held_to_volumes) without its per-farm figures. The History and the restriction log read every subject through it.';
REVOKE ALL ON FUNCTION app_audit_subject(uuid, text, jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_audit_subject(uuid, text, jsonb, timestamptz) TO water_app;

-- The three-argument form the code deployed before 365 calls: the same, with
-- no time (a trimmed run's figures withheld). A reader of each volume gets the
-- subject whole, as from the four-argument form; anyone else gets that form's
-- answer.
CREATE OR REPLACE FUNCTION app_audit_subject(p_project uuid, p_kind text, p_subject jsonb) RETURNS jsonb
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT CASE
			WHEN app_reads_allocation_units(p_project) THEN p_subject
			ELSE app_audit_subject(p_project, p_kind, p_subject, NULL::timestamptz)
		END
	$$;
COMMENT ON FUNCTION app_audit_subject(uuid, text, jsonb) IS
	'The four-argument app_audit_subject (365) with no time, for the code deployed before 365: the subject whole for a reader of each volume (app_reads_allocation_units), else that form''s answer; drop once nothing calls it.';
