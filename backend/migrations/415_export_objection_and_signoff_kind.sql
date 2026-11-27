-- 415_export_objection_and_signoff_kind — two things "Download my data" left
-- out (GET /auth/me/export, auth/export.ts; docs/security.md § Personal
-- information (POPIA)). Expand-only: no table or column changes; each function
-- starts from its latest definition, named at it.
--
--  1. app_subject_scenarios() (latest: 396) gives the scenarios the caller
--     owns as metadata. An application's notice details (166:
--     scenario.objection_address, where written objections go, and
--     objection_closing_date) are what the applicant typed, often their own
--     postal or email address, so they are the applicant's personal
--     information and now come with it. Still never the ops or the
--     description, the project's model record.
--  2. app_subject_export() (latest: 128, unchanged since) gave each sign-off
--     without signoff.kind (167): whether the person signed as the
--     responsible specialist or as an authority-side reviewer of a pack, which
--     is what they attested.

-- 1. The scenarios the caller owns, with the application's notice details
CREATE OR REPLACE FUNCTION app_subject_scenarios() RETURNS jsonb
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	SELECT coalesce(jsonb_agg(jsonb_build_object(
		'scenarioId', s.id,
		'projectId', s.project_id,
		'projectName', p.name,
		'name', s.name,
		'origin', s.origin,
		'status', s.status,
		'outcome', s.outcome,
		'createdAt', s.created_at,
		'submittedAt', s.submitted_at,
		'decidedAt', s.decided_at,
		'objectionAddress', s.objection_address,
		'objectionClosingDate', s.objection_closing_date
	) ORDER BY s.created_at, s.id), '[]'::jsonb)
	FROM scenario s
	LEFT JOIN project p ON p.id = s.project_id
	WHERE app_current_user_id() IS NOT NULL AND s.owner_user_id = app_current_user_id()
	$$;
COMMENT ON FUNCTION app_subject_scenarios() IS
	'The scenarios the signed-in person owns (licence applications and modelling scenarios), as metadata and the application''s notice details (no ops, no description), for the data export (396, 415).';
REVOKE ALL ON FUNCTION app_subject_scenarios() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_subject_scenarios() TO water_app;

-- 2. The rows RLS hides, each sign-off with its kind
CREATE OR REPLACE FUNCTION app_subject_export()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
	DECLARE
		me uuid := app_current_user_id();
		my_email citext;
		verified boolean;
		max_events constant integer := 50000;
		events jsonb;
		n_events integer;
	BEGIN
		IF me IS NULL THEN
			RETURN NULL;
		END IF;
		SELECT u.email, u.email_verified_at IS NOT NULL INTO my_email, verified FROM app_user u WHERE u.id = me;
		IF NOT FOUND THEN
			RETURN NULL;
		END IF;

		SELECT coalesce(jsonb_agg(x.ev ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb), count(*)
		INTO events, n_events
		FROM (
			SELECT jsonb_build_object(
				'id', e.id,
				'projectId', e.project_id,
				'projectName', p.name,
				'kind', e.kind,
				'at', e.created_at,
				'actor', e.actor_label,
				'byYou', e.actor_user_id IS NOT DISTINCT FROM me,
				'subject', e.subject
			) AS ev, e.created_at, e.id
			FROM audit_event e
			JOIN project p ON p.id = e.project_id
			WHERE e.actor_user_id = me
			   OR (e.subject ? 'userId' AND e.subject->>'userId' = me::text)
			   OR (e.kind = 'note.deleted' AND e.subject->>'authorId' = me::text)
			ORDER BY e.created_at DESC, e.id DESC
			LIMIT max_events + 1
		) x;
		IF n_events > max_events THEN
			events := events - max_events;
		END IF;

		RETURN jsonb_build_object(
			'auditEvents', events,
			'auditEventsTruncated', n_events > max_events,
			'invites', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', i.id,
					'projectId', i.project_id,
					'projectName', p.name,
					'projectRole', i.project_role,
					'teamId', i.team_id,
					'teamName', t.name,
					'teamRole', i.team_role,
					'invitedBy', u.display_name,
					'language', i.locale,
					'createdAt', i.created_at,
					'lastSentAt', i.last_sent_at,
					'expiresAt', i.expires_at,
					'farms', (
						SELECT coalesce(jsonb_agg(jsonb_build_object('nodeId', n.id, 'name', n.name) ORDER BY n.name), '[]'::jsonb)
						FROM invite_node inn JOIN node n ON n.id = inn.node_id WHERE inn.invite_id = i.id
					)
				) ORDER BY i.created_at DESC), '[]'::jsonb)
				FROM invite i
				LEFT JOIN project p ON p.id = i.project_id
				LEFT JOIN team t ON t.id = i.team_id
				LEFT JOIN app_user u ON u.id = i.invited_by
				WHERE verified AND i.email = my_email
			),
			'notes', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', nt.id,
					'projectId', nt.project_id,
					'projectName', p.name,
					'body', nt.body,
					'visibility', nt.visibility,
					'nodeId', nt.node_id,
					'nodeName', n.name,
					'runId', nt.run_id,
					'settingKey', nt.setting_key,
					'scenarioId', nt.scenario_id,
					'packId', nt.pack_id,
					'createdAt', nt.created_at,
					'editedAt', nt.edited_at,
					'deletedAt', nt.deleted_at,
					'revisions', (
						SELECT coalesce(jsonb_agg(jsonb_build_object(
							'body', rv.body,
							'writtenAt', rv.written_at,
							'editedAt', rv.edited_at
						) ORDER BY rv.edited_at, rv.id), '[]'::jsonb)
						FROM note_revision rv WHERE rv.note_id = nt.id
					)
				) ORDER BY nt.created_at DESC), '[]'::jsonb)
				FROM note nt
				JOIN project p ON p.id = nt.project_id
				LEFT JOIN node n ON n.id = nt.node_id
				WHERE nt.author_id = me
			),
			'signoffs', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', s.id,
					'projectId', s.project_id,
					'projectName', p.name,
					'runId', s.run_id,
					'packId', s.pack_id,
					'kind', s.kind,
					'fullName', s.full_name,
					'registrationBody', s.registration_body,
					'registrationCategory', s.registration_category,
					'registrationField', s.registration_field,
					'registrationNo', s.registration_no,
					'scope', s.scope,
					'statementVersion', s.statement_version,
					'statementSha256', s.statement_sha256,
					'disclaimerVersion', s.disclaimer_version,
					'signedAt', s.signed_at
				) ORDER BY s.signed_at DESC), '[]'::jsonb)
				FROM signoff s JOIN project p ON p.id = s.project_id
				WHERE s.user_id = me
			),
			'alertSubscriptions', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'projectId', a.project_id,
					'projectName', p.name,
					'kind', a.kind,
					'nodeId', a.node_id,
					'nodeName', n.name,
					'channel', a.channel,
					'mode', a.mode,
					'createdAt', a.created_at,
					'updatedAt', a.updated_at
				) ORDER BY p.name, a.kind), '[]'::jsonb)
				FROM alert_subscription a
				JOIN project p ON p.id = a.project_id
				LEFT JOIN node n ON n.id = a.node_id
				WHERE a.user_id = me
			),
			'reportSubscriptions', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'projectId', rs.project_id,
					'projectName', p.name,
					'frequency', rs.frequency,
					'weekday', rs.weekday,
					'monthDay', rs.month_day,
					'hour', rs.hour,
					'timezone', rs.timezone,
					'enabled', rs.enabled
				) ORDER BY p.name), '[]'::jsonb)
				FROM report_schedule_recipient r
				JOIN report_schedule rs ON rs.id = r.schedule_id
				JOIN project p ON p.id = rs.project_id
				WHERE r.user_id = me
			)
		);
	END
	$function$;
REVOKE ALL ON FUNCTION app_subject_export() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_subject_export() TO water_app;
