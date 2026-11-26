-- 360_accept_invites_each — confirming an address accepts each pending invite
-- on its own, so one refused by a Team's seats leaves only that one pending
-- (docs/followups.md § Billing; docs/billing.md § Team seats).
--
-- app_accept_invites (155, not redefined since) took every live invite for
-- the address in a few set-wide statements. With app.billing_enforced on, one
-- invite past a Team's paid seats (334_team_seats, SQLSTATE 23514, constraint
-- plan_limit) made the whole call fail, and markVerified rolled it all back
-- to a savepoint: the person's invites to other teams and projects stayed
-- pending too. Now the function loops over the invites, each in its own
-- exception block (a subtransaction), and with no invite named
-- (p_invite NULL, markVerified's call) a plan_limit refusal rolls back only
-- that invite's membership, farm links, audit rows and locale, and leaves it
-- pending for the invitations page. Any other error is re-raised, as before
-- (a role_conflict from 163 still fails the confirmation). With one invite
-- named (app_accept_invite, the invitations page) nothing is caught: the
-- refusal reaches the route, which answers 402 plan_limit.
--
-- The invites are taken newest sent first, so the first one accepted gives an
-- account with no locale yet its language (050's rule, now the most recently
-- sent invite it accepts, not one refused).
--
-- From 155's definition; the statements are the same with `id = v_id` for
-- `(p_invite IS NULL OR id = p_invite)`. Signature, return value (the
-- memberships made), owner, SECURITY DEFINER, search_path and grants
-- unchanged (CREATE OR REPLACE keeps the grants). No table, policy or grant
-- changes.

CREATE OR REPLACE FUNCTION app_accept_invites(p_user uuid, p_invite uuid DEFAULT NULL) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_email citext;
		v_name text;
		v_id uuid;
		v_constraint text;
		n_project integer;
		n_team integer;
		n_total integer := 0;
	BEGIN
		SELECT email, display_name INTO v_email, v_name FROM app_user WHERE id = p_user AND email_verified_at IS NOT NULL;
		IF v_email IS NULL THEN
			RETURN 0;
		END IF;
		FOR v_id IN
			SELECT id FROM invite
			WHERE email = v_email AND expires_at > now() AND (p_invite IS NULL OR id = p_invite)
				-- 155: only while its sender may still send it; a lapsed invite stays for the owners.
				AND app_invite_sender_holds(invited_by, project_id, team_id)
			ORDER BY last_sent_at DESC, created_at DESC, id
		LOOP
			BEGIN
				WITH joined AS (
					INSERT INTO project_member (project_id, user_id, role)
						SELECT project_id, p_user, project_role FROM invite
						WHERE id = v_id AND project_id IS NOT NULL
						ON CONFLICT (project_id, user_id) DO NOTHING
						RETURNING project_id, role
				), logged AS (
					INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
						SELECT j.project_id, p_user, left(coalesce(v_name, ''), 200), 'member.added',
							jsonb_build_object('userId', p_user, 'displayName', v_name, 'role', j.role::text, 'via', 'invite')
						FROM joined j
					RETURNING 1
				)
				SELECT count(*) INTO n_project FROM joined;
				WITH linked AS (
					INSERT INTO farm_link (project_id, node_id, user_id, added_by)
						SELECT i.project_id, n.node_id, p_user, i.invited_by
						FROM invite i
						JOIN invite_node n ON n.invite_id = i.id
						JOIN node nd ON nd.id = n.node_id AND nd.kind = 'farm'
						-- 097: a contributor invite's farms too, for the role it made them (not one they held before).
						JOIN project_member m ON m.project_id = i.project_id AND m.user_id = p_user AND m.role = i.project_role
						WHERE i.id = v_id AND i.project_role IN ('farmer', 'contributor')
						ON CONFLICT DO NOTHING
						RETURNING project_id, node_id
				)
				INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
					SELECT l.project_id, p_user, left(coalesce(v_name, ''), 200), 'farmer.linked',
						jsonb_build_object('userId', p_user, 'displayName', v_name, 'nodeId', l.node_id, 'nodeName', nd.name, 'cause', 'invite')
					FROM linked l JOIN node nd ON nd.id = l.node_id;
				-- 072: each team joined is recorded on each of its projects.
				WITH joined_team AS (
					INSERT INTO team_member (team_id, user_id, role)
						SELECT team_id, p_user, team_role FROM invite
						WHERE id = v_id AND team_id IS NOT NULL
						ON CONFLICT (team_id, user_id) DO NOTHING
						RETURNING team_id, role
				), logged_team AS (
					INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
						SELECT p.id, p_user, left(coalesce(v_name, ''), 200), 'team_member.added',
							jsonb_build_object('teamId', t.id, 'team', t.name, 'userId', p_user, 'displayName', v_name,
								'teamRole', j.role::text,
								'role', CASE j.role::text WHEN 'admin' THEN 'owner' WHEN 'member' THEN 'editor' WHEN 'viewer' THEN 'viewer' END,
								'via', 'invite')
						FROM joined_team j JOIN team t ON t.id = j.team_id JOIN project p ON p.team_id = j.team_id
					RETURNING 1
				)
				SELECT count(*) INTO n_team FROM joined_team;
				-- 050: an account with no language yet takes its invite's (the newest accepted, by the loop's order).
				UPDATE app_user SET locale = (SELECT i.locale FROM invite i WHERE i.id = v_id)
				WHERE id = p_user AND locale IS NULL;
				DELETE FROM invite WHERE id = v_id;
				n_total := n_total + n_project + n_team;
			EXCEPTION WHEN check_violation THEN
				GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
				-- 360: only a Team's seats, and only when accepting them all, leave this one pending.
				IF p_invite IS NOT NULL OR v_constraint IS DISTINCT FROM 'plan_limit' THEN
					RAISE;
				END IF;
			END;
		END LOOP;
		RETURN n_total;
	END
	$$;
