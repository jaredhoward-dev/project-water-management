-- 393_prune_shares_on_join — the party prune also runs when a member joins
-- or leaves (issue #901; docs/data-model.md § project_member.party).
--
-- 049's project_member_prune_shares ran only after a member's party or role
-- changed. An applicant removed from a project kept the shares of their own
-- applications (scenario_member cascades only with the *shared-with* member's
-- row, not the owner's), so their old party went on reading them; re-invited
-- with no party, those shares stayed, though app_share_allowed refuses them.
-- Access checks only that a share row exists, so a stale row is a read.
--
--  * INSERT: a member joining (or re-joining) prunes every share, of their
--    applications or to them, that the rule doesn't allow.
--  * DELETE: a member leaving prunes too. Shares *to* them already go with
--    their row (the foreign key cascades); the ones this catches are the
--    shares *of their applications*: with the owner no longer a member,
--    app_share_allowed refuses every one, and the owner's curation is the
--    authority, so the application stops being shared the moment its owner
--    leaves rather than lingering until they rejoin. A re-invited applicant
--    shares again within whatever party the owner puts them in. (Submitted
--    applications stay readable to the assessors by role, not by share.)
--  * One cleanup: every existing share the rule doesn't allow (the rows left
--    by leaves before this migration) goes now.

-- ---------------------------------------------------------------------------
-- project_member_prune_shares, from its latest definition (049): the member
-- is NEW on insert and update, OLD on delete.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION project_member_prune_shares() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		p uuid;
		u uuid;
	BEGIN
		IF TG_OP = 'DELETE' THEN
			p := OLD.project_id;
			u := OLD.user_id;
		ELSE
			p := NEW.project_id;
			u := NEW.user_id;
		END IF;
		DELETE FROM scenario_member sm
		USING scenario s
		WHERE s.id = sm.scenario_id AND sm.project_id = p
			AND (sm.user_id = u OR s.owner_user_id = u)
			AND NOT app_share_allowed(sm.project_id, s.owner_user_id, sm.user_id);
		RETURN NULL;
	END
	$$;

-- 049's update trigger stays as it was (its WHEN needs OLD and NEW); joining
-- and leaving get their own.
CREATE TRIGGER project_member_prune_shares_join_leave AFTER INSERT OR DELETE ON project_member
	FOR EACH ROW EXECUTE FUNCTION project_member_prune_shares();

-- The shares earlier leaves left behind.
DELETE FROM scenario_member sm
USING scenario s
WHERE s.id = sm.scenario_id
	AND NOT app_share_allowed(sm.project_id, s.owner_user_id, sm.user_id);
