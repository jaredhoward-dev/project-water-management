-- 362_gr4j_donor_diagnostics — two diagnostics of a donor set that
-- `backend/scripts/fit-donors.ts` computes and the regional GR4J prior's
-- panel shows (issue #622, docs/followups.md § Regional GR4J prior;
-- docs/model.md §2.10m). Builds on 269_gr4j_donors.sql.
--
-- In this file:
--  * gr4j_donor_dataset gains the flow-space leave-one-out score: each donor
--    in turn is the target of a prior built from the others (the default k
--    and similarity weight), the prior's p50s are run on that donor's own
--    forcing (CHIRPS from our copy, dPET PE), and KGE′ against its observed
--    flow is taken over the days its own fit was scored on. Stored are the
--    median of those KGE′ (loo_flow_kge), the median KGE′ of the same donors'
--    own fits on the same days (loo_flow_kge_fit, what the p50s are judged
--    against) and how many donors were scored (loo_flow_n). All three are
--    null for a set loaded before 362, or one whose file has no score (the
--    synthetic set holds an invented one); set together or not at all.
--  * gr4j_donor gains at_bound: which free parameters the donor's fit left
--    within 1 % (of the box's width) of Perrin's typical bounds, and on which
--    side ('x4:high', 'x1:low'), sorted; '{}' when none. Null: not recorded
--    (a set loaded before 362, or a file that predates the field).
--  * Both are additive and nullable, so every earlier load stays valid and
--    nothing that reads the tables changes. Neither enters the set's SHA-256
--    (engine donorSetCanonical covers what a prior is built from: ids,
--    positions, attributes, parameters, PAWC).
--  * No new table: RLS, the policies and water_app's SELECT grant from 269
--    cover the new columns.

ALTER TABLE gr4j_donor_dataset
	ADD COLUMN loo_flow_kge     double precision CHECK (loo_flow_kge <= 1),
	ADD COLUMN loo_flow_kge_fit double precision CHECK (loo_flow_kge_fit <= 1),
	ADD COLUMN loo_flow_n       integer CHECK (loo_flow_n >= 3),
	ADD CONSTRAINT gr4j_donor_dataset_loo_flow_all
		CHECK ((loo_flow_kge IS NULL) = (loo_flow_kge_fit IS NULL) AND (loo_flow_kge IS NULL) = (loo_flow_n IS NULL));

ALTER TABLE gr4j_donor
	ADD COLUMN at_bound text[] CHECK (
		at_bound <@ ARRAY['x1:low', 'x1:high', 'x2:low', 'x2:high', 'x3:low', 'x3:high', 'x4:low', 'x4:high']::text[]
		AND array_position(at_bound, NULL) IS NULL
	);

COMMENT ON COLUMN gr4j_donor_dataset.loo_flow_kge IS
	'Flow-space leave-one-out score (362): median KGE′ of the prior''s p50s, built from the other donors, run on each held-out donor''s own forcing; null when not scored.';
COMMENT ON COLUMN gr4j_donor_dataset.loo_flow_kge_fit IS
	'Median KGE′ of the same donors'' own fits on the same days: what loo_flow_kge is judged against (362).';
COMMENT ON COLUMN gr4j_donor_dataset.loo_flow_n IS
	'How many donors the flow-space leave-one-out scored (362).';
COMMENT ON COLUMN gr4j_donor.at_bound IS
	'The free parameters the donor''s fit left within 1 % of a typical bound, with the side (''x4:high''); ''{}'' none; null not recorded (362).';
