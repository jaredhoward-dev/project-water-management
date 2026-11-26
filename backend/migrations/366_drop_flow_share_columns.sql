-- 366: drop the retired flow-share node columns (issue #836; the contract
-- half of 266_retire_flow_share_method.sql, issue #616).
--
-- Engine 1.105.0 gives every unit one share, its natural MAR share, so b023's
-- Hi/Lo MAP and Specific methods are gone. 266 stripped the settings and
-- wrote one settings.flow_share_reset History event per project that used
-- them (listing each unit's values), and the backend from that release
-- neither reads nor writes node.area_hi_km2, node.area_lo_km2 or
-- node.flow_share_manual (model/store.ts). That release was backend@0.10.0
-- and production runs 0.26.2, so no backend that reads them can be rolled
-- back to, and the columns go.
--
-- Nothing else depends on them: no policy, view, index or function names
-- them (only 001, which made them, and 266's one-off History DO block), and
-- the row-type readers (app_et_observation_load's node%ROWTYPE, the generic
-- to_jsonb(NEW) triggers) look columns up by name. Their CHECK constraints
-- (from 001) go with them. Stored runs, model revisions, scenario ops and
-- 266's History events keep the old values in their JSON, as records.
ALTER TABLE node
	DROP COLUMN area_hi_km2,
	DROP COLUMN area_lo_km2,
	DROP COLUMN flow_share_manual;
