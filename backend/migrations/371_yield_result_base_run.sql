-- 371_yield_result_base_run — a scenario's yield records the base run it ran on.
--
-- 320 recorded the scenario's ops_sha256 so the Yield panel could say a
-- stored yield was worked out on other changes. A rebase (POST
-- …/scenarios/:sid/rebase) moves the scenario onto another base run and
-- keeps its ops, so the hash stays the same: a yield worked out on the old
-- base run (another rainfall and flow record, another model) read as the
-- current one. From here the yield job also writes the scenario's
-- base_run_id at the time into `base_run_id`, the API serves it, and the
-- panel says "worked out on another base run" when it differs from the
-- scenario's.
--
-- No foreign key: like ops_sha256 it is a record of what the job ran on, and
-- outlives the run (a scenario's base run can't be deleted while it is the
-- base, but an old base can be). NULL: a yield on a run (its own input), or a
-- scenario's from before this (unknown; judged by the ops alone). No
-- backfill: the base run at the time can't be recovered.
--
-- A new column of yield_result: the table's existing grants (SELECT, INSERT,
-- DELETE to water_app, 040) and policies (040, 045, 096) cover it.
ALTER TABLE yield_result ADD COLUMN base_run_id uuid;
ALTER TABLE yield_result ADD CONSTRAINT yield_result_base_run_scenario
	CHECK (base_run_id IS NULL OR scenario_id IS NOT NULL);
COMMENT ON COLUMN yield_result.base_run_id IS
	'A scenario''s yield: the scenario''s base_run_id when its job ran (371). NULL = a yield on a run, or a scenario''s from before 371.';
