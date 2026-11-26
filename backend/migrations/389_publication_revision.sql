-- 389_publication_revision — a revision counter on a publication, for the
-- Publish dialog's and Edit notice form's basis (issue #885; #863 added the
-- basis; docs/api.md § Publication).
--
-- A publish or notice save names the publication its form was filled in
-- from, and is refused 409 publication_changed when that is no longer the
-- current publication as it stands. #863 compared updated_at, which the API
-- gives to the millisecond while Postgres keeps microseconds: two notice
-- saves committed in the same millisecond looked alike. A counter can't.
--
-- run_publication.revision: 1 when published, one more on every notice
-- save (an UPDATE that sets note, restriction_level, restriction_pct,
-- notice or next_expected_on). Kept by a trigger, not by the route, so
-- water_app's column grants (022, 081, 163) stay as they are: water_app
-- can't set it (no UPDATE on the column), and an INSERT's value is
-- overwritten. Superseding, endorsing or an account going (updated_by,
-- published_by set null) leaves it alone.
--
-- The trigger is named to fire before run_publication_final (triggers on a
-- row fire in name order): a superseded publication's notice columns
-- written again, even unchanged, bump the revision, and run_publication_final
-- then refuses the change to history, as it refuses any other.
--
-- Existing rows start at 1; nothing in the API sent a revision before this.

ALTER TABLE run_publication ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1);

CREATE FUNCTION run_publication_count_revision() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF TG_OP = 'INSERT' THEN
			NEW.revision := 1;
		ELSE
			NEW.revision := OLD.revision + 1;
		END IF;
		RETURN NEW;
	END
	$$;

CREATE TRIGGER run_publication_count_revision BEFORE INSERT OR UPDATE OF note, restriction_level, restriction_pct, notice, next_expected_on
	ON run_publication FOR EACH ROW EXECUTE FUNCTION run_publication_count_revision();

REVOKE ALL ON FUNCTION run_publication_count_revision() FROM PUBLIC, water_app;
