-- 358_feed_mark_keeps_progress — refreshing a feed's mark alone keeps its
-- progress (followups F7b; docs/maps.md § Rain for each unit, docs/data-model.md
-- § Series provenance).
--
-- A gridded feed's config carries, beside the cells it reads, a mark naming
-- where they came from: `unit` (the land unit's polygon, feeds/fromUnits.ts)
-- or `boundary` (the catchment boundary, feeds/fromBoundary.ts), each with
-- the outline's version and hash (feeds/config.ts UnitMark, BoundaryMark).
-- Rain for each unit now rewrites the mark alone when a parcel is reshaped
-- to the same cells (its `mark` action), but data_feed_stamp treated any
-- config change as another place: it cleared the feed's progress, so the
-- next fetch read the whole record again (an `rnl` feed back to 1981) for
-- the same days, and dropped any area replacement staged over the same cells.
--
-- In this file: data_feed_stamp, from 296's definition (the latest),
-- compares the config without its `unit` and `boundary` keys wherever it
-- compared the whole config: a change confined to them keeps the feed's
-- progress and its stage; any other config change resets both as before.
-- Same search_path, still not SECURITY DEFINER; a trigger function has no
-- grants of its own (it runs as the table's writer), so none change. No
-- table, column, policy or foreign key.

CREATE OR REPLACE FUNCTION data_feed_stamp() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		-- The config without its marks (358): what the feed reads, as against where its cells came from.
		new_reads jsonb := NEW.config - ARRAY['unit', 'boundary'];
		old_reads jsonb := CASE WHEN TG_OP = 'UPDATE' THEN OLD.config - ARRAY['unit', 'boundary'] END;
	BEGIN
		IF current_user <> 'water_app' THEN
			RETURN NEW; -- a SECURITY DEFINER health update, or the owner role
		END IF;
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a data feed needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.acting_user_id := uid;
		NEW.updated_at := now();
		IF TG_OP = 'INSERT' THEN
			NEW.created_by := uid;
			NEW.created_at := now();
			NEW.last_scheduled_at := NULL;
			NEW.last_attempt_at := NULL;
			NEW.last_success_at := NULL;
			NEW.last_data_date := NULL;
			NEW.last_value := NULL;
			NEW.consecutive_failures := 0;
			NEW.last_error := NULL;
			NEW.last_meta := NULL;
			NEW.fetch_job_id := NULL;
			NEW.fetch_start := NULL;
			NEW.fetch_end := NULL;
		ELSE
			NEW.id := OLD.id;
			NEW.project_id := OLD.project_id;
			NEW.created_by := OLD.created_by;
			NEW.created_at := OLD.created_at;
			NEW.last_attempt_at := OLD.last_attempt_at;
			NEW.last_success_at := OLD.last_success_at;
			NEW.last_value := OLD.last_value;
			NEW.last_meta := OLD.last_meta;
			NEW.last_error := OLD.last_error;
			NEW.fetch_job_id := OLD.fetch_job_id;
			NEW.fetch_start := OLD.fetch_start;
			NEW.fetch_end := OLD.fetch_end;
			IF (NEW.source IS DISTINCT FROM OLD.source OR NEW.target_kind IS DISTINCT FROM OLD.target_kind OR NEW.target_name IS DISTINCT FROM OLD.target_name)
				AND NEW.replace_series_from IS NOT DISTINCT FROM OLD.replace_series_from THEN
				-- The confirmation named what the old target held.
				NEW.replace_series_from := NULL;
			END IF;
			IF NEW.replace_series_from IS DISTINCT FROM OLD.replace_series_from OR NEW.source IS DISTINCT FROM OLD.source
				OR new_reads IS DISTINCT FROM old_reads OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
				OR NEW.target_name IS DISTINCT FROM OLD.target_name THEN
				DELETE FROM feed_stage WHERE feed_id = OLD.id;
			END IF;
			IF NEW.source IS DISTINCT FROM OLD.source OR new_reads IS DISTINCT FROM old_reads
				OR NEW.target_kind IS DISTINCT FROM OLD.target_kind OR NEW.target_name IS DISTINCT FROM OLD.target_name
				OR (NEW.replace_series_from IS NOT NULL AND NEW.replace_series_from IS DISTINCT FROM OLD.replace_series_from) THEN
				-- A different place or series, or a series about to be replaced:
				-- the feed's data so far says nothing about what it will hold.
				NEW.last_data_date := NULL;
				NEW.last_value := NULL;
				NEW.last_success_at := NULL;
				NEW.last_meta := NULL;
				NEW.last_error := NULL;
				NEW.consecutive_failures := 0;
				NEW.last_scheduled_at := NULL;
				-- An answer for the old settings is dropped anyway (the feed's version changed).
				NEW.fetch_job_id := NULL;
				NEW.fetch_start := NULL;
				NEW.fetch_end := NULL;
			ELSE
				NEW.last_data_date := OLD.last_data_date;
				NEW.consecutive_failures := OLD.consecutive_failures;
				-- Saving (or re-enabling) makes it due now.
				NEW.last_scheduled_at := CASE WHEN NEW.enabled AND NOT OLD.enabled THEN NULL ELSE OLD.last_scheduled_at END;
			END IF;
		END IF;
		-- The config an area replacement started from lives only as long as its confirmation (296).
		IF NEW.replace_series_from IS NULL OR NEW.replace_series_from NOT LIKE 'area:%' THEN
			NEW.replace_config_from := NULL;
		END IF;
		RETURN NEW;
	END
	$$;
