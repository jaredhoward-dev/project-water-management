-- 331_billing_rls_order — 323's billing account trigger waits for a project
-- the caller may make, and plan prices need a signed-in person (issue #641;
-- docs/billing.md, docs/data-model.md § Billing).
--
--   1. project_billing_account_admit, a BEFORE INSERT OR UPDATE OF team_id
--      trigger on project, caller's rights. BEFORE triggers run before RLS's
--      WITH CHECK, and 323's project_billing_account_set is SECURITY DEFINER:
--      it made (billing_account_ensure) and counted a billing account for
--      whatever maker or team the new row named, before RLS refused the row.
--      The statement rolled back, so nothing stayed, but a maker or team that
--      doesn't exist failed the account's foreign key first (23503, a 400
--      "references something that does not exist") where RLS's refusal is a
--      403 (errors.db.test.ts). Named to fire first (triggers fire in name
--      order: …_admit, …_guard, …_set), as water_app only, it refuses with
--      insufficient_privilege (42501, the same code RLS raises) a new project
--      whose maker isn't the signed-in person, and a project landing in a
--      team the person has no role in. Both are weaker than project_insert
--      and project_update (008: created_by = the caller; a member or admin of
--      a team moved into), so it never refuses a row RLS admits; RLS still
--      decides the rest. The schema owner and definer functions (current_user
--      isn't water_app) are untouched, as 323's guard.
--   2. plan_read: USING (true) → a signed-in person (app_current_user_id()),
--      like the other reference tables (quaternary_reference, …). The public
--      pricing route reads through app_billing_plans() (323, SECURITY
--      DEFINER), and every other reader is a definer function or runs as the
--      recipient (billing/renewal.ts), so only an ingest API key's session
--      (ingest.security.db.test.ts) and a no-user transaction lose the
--      direct read, neither of which has a reason to price plans.
--
-- Forward-only (CLAUDE.md rule 2): 323 stays as it is.

CREATE FUNCTION project_billing_account_admit() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF current_user <> 'water_app' THEN
			RETURN NEW;
		END IF;
		IF TG_OP = 'INSERT' AND NEW.created_by IS DISTINCT FROM app_current_user_id() THEN
			RAISE EXCEPTION 'a new project is made by the signed-in person' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.team_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.team_id IS DISTINCT FROM OLD.team_id)
		   AND app_team_role(NEW.team_id) IS NULL THEN
			RAISE EXCEPTION 'a project goes only into a team you are in' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER project_billing_account_admit BEFORE INSERT OR UPDATE OF team_id ON project
	FOR EACH ROW EXECUTE FUNCTION project_billing_account_admit();
REVOKE ALL ON FUNCTION project_billing_account_admit() FROM PUBLIC, water_app;

DROP POLICY plan_read ON plan;
CREATE POLICY plan_read ON plan FOR SELECT USING (app_current_user_id() IS NOT NULL);
