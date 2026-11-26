-- 383_erase_handover_and_invites — two things an account deletion left
-- behind (docs/security.md § Personal information (POPIA), the account
-- deletion audit of 2026-11-26).
--
--  * The leaver's name in a hand-over. When a member leaves a team, or is
--    removed from it, a team project they alone owned passes to a team admin
--    (teams/leaveProjects.ts handOwnership), and the member.added or
--    member.role event that records it names the leaver as `handedFrom`, by
--    display name only. The deletion trigger pseudonymises a subject by its
--    `userId`, which is the admin's here, so the leaver's name stayed in the
--    History after their account was gone. Since this change the event also
--    carries `handedFromId`; events written before are matched through the
--    member.removed event the same transaction wrote (the same project, the
--    same created_at, now() being the transaction's time, and the leaver's
--    userId with leftTeam).
--
--  * Invites to their address. A pending invite *to* the person (not one they
--    sent, which cascades with invited_by) kept their full address for its 7
--    days live and the 90 days it is kept expired (048 app_purge_invites),
--    although 160 already blanks the masked address in the invite.* events.
--    A live one would also let whoever signs up with the address again join
--    as them. They go with the account (invite_node cascades from invite).
--
-- In this file:
--  * app_user_pseudonymise, from its latest definition (161_licence_record):
--    the two additions above; the rest unchanged, the public-records team's
--    events still left as they are.
CREATE OR REPLACE FUNCTION app_user_pseudonymise() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_masked text := app_mask_email(OLD.email::text);
	BEGIN
		-- 161: the events of a public-records team's projects are left as they are (each UPDATE below skips them).
		UPDATE audit_event SET actor_label = 'Deleted user'
			WHERE actor_user_id = OLD.id AND project_id NOT IN (SELECT p.id FROM project p JOIN team t ON t.id = p.team_id WHERE t.public_records);
		UPDATE audit_event SET subject = jsonb_set(subject, '{displayName}', to_jsonb('Deleted user'::text))
			WHERE subject->>'userId' = OLD.id::text AND subject ? 'displayName'
			  AND project_id NOT IN (SELECT p.id FROM project p JOIN team t ON t.id = p.team_id WHERE t.public_records);
		-- 383: a hand-over names the leaver as handedFrom: by id since 383 (handedFromId), and through the
		-- member.removed event the same transaction wrote for the events written before.
		UPDATE audit_event e SET subject = jsonb_set(e.subject, '{handedFrom}', to_jsonb('Deleted user'::text))
			WHERE e.kind IN ('member.added', 'member.role') AND e.subject ? 'handedFrom' AND (
				e.subject->>'handedFromId' = OLD.id::text
				OR (NOT e.subject ? 'handedFromId' AND EXISTS (
					SELECT 1 FROM audit_event r
					WHERE r.project_id = e.project_id AND r.kind = 'member.removed' AND r.created_at = e.created_at
					  AND r.subject->>'userId' = OLD.id::text AND r.subject->>'leftTeam' = 'true'
				))
			) AND e.project_id NOT IN (SELECT p.id FROM project p JOIN team t ON t.id = p.team_id WHERE t.public_records);
		-- note.deleted names the note's author: by id since 048 (authorId), and
		-- through the note itself for the events written before.
		UPDATE audit_event e SET subject = jsonb_set(e.subject, '{author}', to_jsonb('Deleted user'::text))
			WHERE e.kind = 'note.deleted' AND e.subject ? 'author' AND (
				e.subject->>'authorId' = OLD.id::text
				OR EXISTS (SELECT 1 FROM note n WHERE n.id::text = e.subject->>'noteId' AND n.author_id = OLD.id)
			) AND e.project_id NOT IN (SELECT p.id FROM project p JOIN team t ON t.id = p.team_id WHERE t.public_records);
		-- 160: the masked address in invite.sent / invite.revoked / invite.declined.
		IF v_masked <> '•••' THEN
			UPDATE audit_event SET subject = jsonb_set(subject, '{email}', to_jsonb('•••'::text))
				WHERE kind LIKE 'invite.%' AND lower(subject->>'email') = lower(v_masked)
				  AND project_id NOT IN (SELECT p.id FROM project p JOIN team t ON t.id = p.team_id WHERE t.public_records);
		END IF;
		-- 383: invites to their address, live or expired (the ones they sent go with invited_by's cascade).
		DELETE FROM invite WHERE email = OLD.email;
		-- 066: a PDF someone else asked for no longer names them as a recipient
		-- (their own reports go with requested_by's cascade).
		UPDATE report SET email_to = array_remove(email_to, OLD.id)
			WHERE OLD.id = ANY (email_to) AND requested_by <> OLD.id;
		-- 138: an ensemble they started and never completed; nothing rests on it.
		DELETE FROM run_uncertainty WHERE created_by = OLD.id AND status = 'started';
		-- 138: their draft applications, with the runs only they could see
		-- (scenario_drop_application_runs), unless the project keeps the draft
		-- or one of its runs (then it stays, its applicant cleared by the key).
		DELETE FROM scenario s
			WHERE s.owner_user_id = OLD.id AND s.origin = 'applicant' AND s.status = 'draft'
			  AND NOT EXISTS (SELECT 1 FROM note n WHERE n.scenario_id = s.id AND n.visibility = 'public_participation')
			  AND NOT EXISTS (SELECT 1 FROM evidence_pack ep WHERE ep.scenario_id = s.id)
			  AND NOT EXISTS (SELECT 1 FROM model_run r WHERE r.scenario_id = s.id AND app_run_kept(r.id));
		RETURN OLD;
	END
	$$;
