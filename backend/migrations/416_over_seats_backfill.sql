-- 416_over_seats_backfill — record the teams already over their paid seats
-- (round 2026-11-28, the enforcement rehearsal; docs/billing.md § Team seats).
--
-- 403 records billing_account.over_seats_since when a subscription's seats,
-- status or plan change, and 404 when an editor is added. A team that went
-- over before those migrations and hasn't changed since carries no marker, and
-- nothing writes one later: the tick (409's app_plan_pause_tick) re-syncs only
-- the accounts already marked. Its Plan page shows team.overSeats with a null
-- since, and the operator learns of it only from the billing report's recount.
--
-- This runs 403's app_team_seats_sync (its only definition: the recount under
-- 334's account lock) once on every team account with no marker. It only ever
-- sets a marker here: an account it finds within its seats has none to clear,
-- and an account already marked is left alone (its since stays when it was
-- first seen). Running it again changes nothing. The since it writes is this
-- migration's time, the first time the app saw the team over.
--
-- No table, function, policy or grant changes.

DO $$
DECLARE
	v_account uuid;
BEGIN
	FOR v_account IN
		SELECT id FROM billing_account WHERE team_id IS NOT NULL AND over_seats_since IS NULL ORDER BY id
	LOOP
		PERFORM app_team_seats_sync(v_account);
	END LOOP;
END
$$;
