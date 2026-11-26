-- 390_future_yield_boundary — a stored § 8 Future yield records which
-- catchment boundary its factor table was read over (issue #889; docs/data-model.md
-- § Future yield, docs/evidence-pack.md § Future yield).
--
-- The Scenarios tab's climate_factors (282) keeps the SHA-256 of the boundary
-- its factors were read over, so the picker says when the boundary has been
-- drawn again since. A future_yield row (280) didn't, so an evidence report's
-- § 8 used a result read over an old boundary without saying so. This adds
-- the same hash; the API and the report compare it with the boundary now
-- (backend future/store.ts futureYieldBoundary) and flag the result when it
-- differs or the boundary is gone, and the report's futureYield check holds
-- the pack back from issue until it is run again.
--
-- In this file:
--  * `future_yield.boundary_sha256`: nullable (expand only): rows written
--    before this migration have none and read as "not recorded"; every new
--    row's job writes it. Same shape check as climate_factors.boundary_sha256.
--  * No grant change: water_app's table-level SELECT and INSERT (280) cover
--    the new column, and it still has no UPDATE. No new foreign key, so no
--    new index; RLS, the guard trigger and the policies are unchanged.
--  * Nothing here feeds a saved run, so there is no ENGINE_VERSION change.

ALTER TABLE future_yield ADD COLUMN boundary_sha256 text CHECK (boundary_sha256 IS NULL OR boundary_sha256 ~ '^[0-9a-f]{64}$');
COMMENT ON COLUMN future_yield.boundary_sha256 IS
	'SHA-256 (hex) of the catchment boundary''s geometry as canonical JSON when the job read the factor table over it (390_future_yield_boundary, issue #889); null for rows written before 390.';
