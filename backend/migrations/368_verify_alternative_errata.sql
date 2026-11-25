-- 368_verify_alternative_errata — the public verify lookup's errata found
-- since issue read the mitigation alternatives' runs too (docs/evidence-pack.md
-- § Verification, § Mitigation alternatives).
--
-- A pack's page 1 prints each cited alternative's figures (evidence-26,
-- 298_scenario_alternatives), so the report records the errata of their
-- engines, and the pack's own page lists an erratum found since for one of
-- them (evidence/packs.ts packErrataFoundSince). Verify, the share link and an
-- applicant's copy (all through app_verify_pack) read only the baseline and
-- application runs, so an erratum found after issue that applied only to an
-- alternative's engine (an alternative may run on another engine than the
-- application) showed on the team's page and never to the authority.
--
-- In this file:
--  * app_verify_pack, from its latest definition (314_verify_earlier_statement):
--    `runs` adds, after the pack's own two, one entry per alternative the
--    manifest cites, in its order: the run's engine and its fits' engines
--    (run_fit_engine_versions) while the run exists, else the engine the
--    manifest names, with no fit, as the in-app check counts it. `runs` still
--    never leaves the API (share/links.ts toVerify turns it into
--    errataFoundSince). An invalid run id in the manifest matches no run.
--  * Nothing else changes. CREATE OR REPLACE keeps its grants (water_app and
--    the anonymous lookup call it as before); no table, policy or grant
--    change, so no RLS change. search_path stays pinned.

CREATE OR REPLACE FUNCTION app_verify_pack(p_code text) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		c text := lower(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'));
		p evidence_pack;
		-- The statement the issue rested on: its latest specialist sign-off's (314).
		i record;
	BEGIN
		IF c ~ '^[0-9a-f]{64}$' THEN
			SELECT * INTO p FROM evidence_pack WHERE manifest_sha256 = c;
		ELSIF c ~ '^[0-9a-f]{12}$' THEN
			SELECT * INTO p FROM evidence_pack WHERE left(manifest_sha256, 12) = c;
		ELSE
			RETURN NULL;
		END IF;
		IF NOT FOUND OR p.status = 'draft' OR p.issued_at IS NULL THEN
			RETURN NULL;
		END IF;
		SELECT s.statement_sha256 AS sha, s.statement_version AS version INTO i
		FROM signoff s WHERE s.pack_id = p.id AND s.kind = 'specialist'
		ORDER BY s.signed_at DESC, s.id DESC LIMIT 1;
		RETURN jsonb_build_object(
			'status', p.status,
			'version', p.version,
			'issuedAt', p.issued_at,
			'catchment', p.manifest->'project'->>'name',
			'engineVersion', p.engine_version,
			'reportVersion', p.report_version,
			'manifestSha256', p.manifest_sha256,
			'pdfSha256', p.pdf_sha256,
			'bundleSha256', p.bundle_sha256,
			'successorSha256', (SELECT s.manifest_sha256 FROM evidence_pack s WHERE s.id = p.superseded_by_pack_id),
			'withdrawnReason', CASE WHEN p.status = 'withdrawn' THEN p.status_reason END,
			'methodology', jsonb_build_object(
				'version', p.manifest->'report'->'verification'->'methodology'->>'version',
				'sha256', p.manifest->'report'->'verification'->'methodology'->>'sha256'
			),
			'errata', (
				SELECT coalesce(jsonb_agg(jsonb_build_object('id', e->>'id', 'summary', e->>'summary') ORDER BY ord), '[]'::jsonb)
				FROM jsonb_array_elements(coalesce(p.manifest->'report'->'verification'->'errata', '[]'::jsonb)) WITH ORDINALITY AS x(e, ord)
			),
			-- For the API's errata found since issue only; never returned as is (132). The pack's two runs, baseline first, then (368) its alternatives'.
			'runs', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'engineVersion', r.engine_version,
					'fitEngineVersions', to_jsonb(run_fit_engine_versions(r.inputs, r.summary))
				) ORDER BY r.id IS DISTINCT FROM p.baseline_run_id), '[]'::jsonb)
				FROM model_run r WHERE r.id = p.baseline_run_id OR r.id = p.scenario_run_id
			) || (
				-- 368: the mitigation alternatives the manifest cites (evidence-26), in its order: page 1 prints their
				-- figures, so an erratum found since for one of their engines (or fits') is the pack's. A run that is
				-- gone counts by the engine the manifest names, without a fit (evidence/packs.ts packErrataFoundSince).
				SELECT coalesce(jsonb_agg(
					CASE WHEN r.id IS NOT NULL
						THEN jsonb_build_object('engineVersion', r.engine_version, 'fitEngineVersions', to_jsonb(run_fit_engine_versions(r.inputs, r.summary)))
						ELSE jsonb_build_object('engineVersion', x.a->'engineVersion', 'fitEngineVersions', '[]'::jsonb)
					END ORDER BY x.ord), '[]'::jsonb)
				FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.manifest->'report'->'alternatives') = 'array' THEN p.manifest->'report'->'alternatives' ELSE '[]'::jsonb END)
					WITH ORDINALITY AS x(a, ord)
				LEFT JOIN model_run r ON r.project_id = p.project_id
					AND r.id = CASE WHEN x.a->>'runId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (x.a->>'runId')::uuid END
				WHERE jsonb_typeof(x.a->'runId') = 'string'
			),
			'signers', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'fullName', s.full_name,
					'registrationBody', s.registration_body,
					'registrationCategory', s.registration_category,
					'registrationField', s.registration_field,
					'registrationNo', s.registration_no,
					'signedAt', s.signed_at,
					-- 167: who signed as what, and the check bound at issue (none: self-declared).
					'kind', s.kind,
					'registrationCheck', (
						SELECT jsonb_build_object('checkedAt', rc.checked_at, 'checkedByOrg', rc.checked_by_org)
						FROM signoff_registration_check b JOIN registration_check rc ON rc.id = b.check_id
						WHERE b.signoff_id = s.id
					),
					-- 314: the statement it was made against, and whether that is earlier than the one the issue rested on.
					'statementVersion', s.statement_version,
					'earlierStatement', i.sha IS NOT NULL AND s.statement_sha256 IS DISTINCT FROM i.sha
				) ORDER BY s.signed_at, s.id), '[]'::jsonb)
				FROM signoff s WHERE s.pack_id = p.id
			),
			-- 314: the version of the statement the issue rested on (null: no specialist sign-off, a pack from before 167).
			'statementVersion', i.version
		);
	END
	$$;
