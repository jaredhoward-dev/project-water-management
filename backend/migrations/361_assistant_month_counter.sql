-- 361_assistant_month_counter — the assistant's dollar sums read from counters
-- at begin instead of summed over every account's rows (docs/followups.md §
-- Billing, "Every turn's begin sums the month's dollars"; docs/billing.md §
-- Assistant dollar caps, The counters). A performance change: every begin
-- answers exactly as it did.
--
-- Before: 336's assistant_dollars_spent scanned the UTC month's
-- assistant_usage (joined to project), the SAST day's assistant_day_usage and
-- every reservation, and called assistant_pool_account once per account with
-- any of them, all under 264's deployment-wide assistant_usage:all lock. Its
-- cost grew with every account that used the assistant this month.
--
-- Now the recorded dollars (assistant_usage.cost_usd_micros and
-- assistant_day_usage.cost_usd_micros) are also kept in three counters,
-- written by triggers on the tables they count, so every writer (the charge,
-- the expiry sweep that converts a reservation, the purge, a project's or an
-- account's deletion, a project moving account) keeps them exact:
--   - assistant_month_counter (account, UTC month): the account's projects'
--     recorded cost that month (assistant_usage through project.billing_account_id);
--   - assistant_pool_counter ('month', UTC month) and ('day', SAST day): the
--     same over every Free-pool account (assistant_pool_account), the month's
--     from assistant_usage and the day's from assistant_day_usage;
--   - assistant_pool_member: the accounts whose spend is in the pool
--     counter. Pool membership is read live at begin (a Pro account's month
--     leaves the pool when it upgrades, and a cancelled one's joins), so a
--     subscription change moves the account's whole retained spend in or
--     out of the pool counter (assistant_pool_sync).
-- The reservations are still summed live: the table holds only the turns in
-- flight (each begin settles the expired ones first), so that sum stays small
-- however many accounts there are. A person's own month (member_month) is
-- summed live from their own usage rows (assistant_usage_user_idx), and their
-- day is one assistant_day_usage row, as before.
--
-- Exact under concurrency: assistant_dollars_spent stays one SQL statement,
-- so the counters and the reservations are read from one snapshot, and a
-- charge (reservation deleted, usage and day rows and counters written) is
-- one transaction: a begin sees all of it or none, as it saw the rows. Every
-- trigger takes a per-account advisory lock (assistant_counter_lock) before
-- it reads or writes that account's counters, so a charge and a subscription
-- change on the same account can't both miss each other's delta; the pool
-- counter rows themselves are updated with `+ delta` under their row lock.
-- 264's assistant_usage:all lock is unchanged: begins stay serialised, since
-- the caps still read, then reserve. The pool counter's two rows (this month,
-- today) are a hot spot for charges of pool accounts: each holds the row
-- until it commits, a short transaction.
--
-- A trigger refuses an UPDATE that moves a usage row to another project or
-- month, or a day row to another account or day: nothing does, and the
-- counters assume it.
--
-- Backfilled here from the existing rows, with the tables written to locked
-- until the migration commits.
--
-- Started from the latest definitions: assistant_dollars_spent (336, same
-- signature and columns), app_purge_assistant (336, which now also drops the
-- counter rows of purged months). app_assistant_begin (342), app_assistant_charge
-- (337), assistant_settle_expired (336) and the 8-argument begin are unchanged.

LOCK TABLE assistant_usage, assistant_day_usage, assistant_reservation, subscription, project, billing_account IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE assistant_month_counter (
	billing_account_id uuid NOT NULL REFERENCES billing_account (id) ON DELETE CASCADE,
	-- The first day of a UTC month, as assistant_usage.month.
	month              date NOT NULL CHECK (month = date_trunc('month', month)::date),
	cost_usd_micros    bigint NOT NULL DEFAULT 0,
	-- Covers the account key.
	PRIMARY KEY (billing_account_id, month)
);
-- The purge.
CREATE INDEX assistant_month_counter_month_idx ON assistant_month_counter (month);
COMMENT ON TABLE assistant_month_counter IS
	'Each billing account''s recorded assistant cost per UTC month: the sum of its projects'' assistant_usage.cost_usd_micros, kept by triggers (361). Owner only.';

CREATE TABLE assistant_pool_counter (
	period          text NOT NULL CHECK (period IN ('month', 'day')),
	-- A UTC month's first day (period month) or a SAST day (period day), as the rows counted.
	start           date NOT NULL,
	cost_usd_micros bigint NOT NULL DEFAULT 0,
	PRIMARY KEY (period, start)
);
COMMENT ON TABLE assistant_pool_counter IS
	'The Free pool''s recorded assistant cost: per UTC month (assistant_usage) and per SAST day (assistant_day_usage) over the accounts in assistant_pool_member, kept by triggers (361). Owner only.';

CREATE TABLE assistant_pool_member (
	-- Covers the account key.
	billing_account_id uuid PRIMARY KEY REFERENCES billing_account (id) ON DELETE CASCADE
);
COMMENT ON TABLE assistant_pool_member IS
	'The billing accounts whose assistant spend is in assistant_pool_counter: those assistant_pool_account says draw on the Free pool, kept in step by assistant_pool_sync (361). Owner only.';

-- Owner only, as assistant_reservation: RLS on, no policy, no privilege for water_app.
ALTER TABLE assistant_month_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_pool_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_pool_member ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON assistant_month_counter, assistant_pool_counter, assistant_pool_member FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- Helpers (internal: run as the definer triggers that call them)
-- ---------------------------------------------------------------------------

-- One account's counters are written by one transaction at a time.
CREATE FUNCTION assistant_counter_lock(p_account uuid) RETURNS void
	LANGUAGE sql VOLATILE SET search_path = public
	AS $$ SELECT pg_advisory_xact_lock(hashtext('assistant_counter:' || p_account::text)) $$;
REVOKE ALL ON FUNCTION assistant_counter_lock(uuid) FROM PUBLIC;

CREATE FUNCTION assistant_pool_bump(p_period text, p_start date, p_delta bigint) RETURNS void
	LANGUAGE sql VOLATILE SET search_path = public
	AS $$
		INSERT INTO assistant_pool_counter (period, start, cost_usd_micros) VALUES (p_period, p_start, p_delta)
		ON CONFLICT (period, start) DO UPDATE SET cost_usd_micros = assistant_pool_counter.cost_usd_micros + EXCLUDED.cost_usd_micros
	$$;
REVOKE ALL ON FUNCTION assistant_pool_bump(text, date, bigint) FROM PUBLIC;

-- Add (p_sign 1) or take out (-1) an account's whole retained spend from the pool counter.
CREATE FUNCTION assistant_pool_add(p_account uuid, p_sign integer) RETURNS void
	LANGUAGE sql VOLATILE SET search_path = public
	AS $$
		INSERT INTO assistant_pool_counter (period, start, cost_usd_micros)
			SELECT 'month', c.month, p_sign * c.cost_usd_micros FROM assistant_month_counter c
			WHERE c.billing_account_id = p_account AND c.cost_usd_micros <> 0
		ON CONFLICT (period, start) DO UPDATE SET cost_usd_micros = assistant_pool_counter.cost_usd_micros + EXCLUDED.cost_usd_micros;
		INSERT INTO assistant_pool_counter (period, start, cost_usd_micros)
			SELECT 'day', d.day, p_sign * sum(d.cost_usd_micros) FROM assistant_day_usage d
			WHERE d.billing_account_id = p_account GROUP BY d.day HAVING sum(d.cost_usd_micros) <> 0
		ON CONFLICT (period, start) DO UPDATE SET cost_usd_micros = assistant_pool_counter.cost_usd_micros + EXCLUDED.cost_usd_micros;
	$$;
REVOKE ALL ON FUNCTION assistant_pool_add(uuid, integer) FROM PUBLIC;

-- Bring an account's pool membership in step with assistant_pool_account
-- (a deleted account is in no pool). The caller holds the account's lock and
-- has already written its own change to the counted tables, so 'added' means
-- the pool counter now includes it; only 'in' asks the caller to add its delta.
CREATE FUNCTION assistant_pool_sync(p_account uuid) RETURNS text
	LANGUAGE plpgsql VOLATILE SET search_path = public
	AS $$
	DECLARE
		v_counted boolean := EXISTS (SELECT 1 FROM assistant_pool_member WHERE billing_account_id = p_account);
		v_should boolean := EXISTS (SELECT 1 FROM billing_account WHERE id = p_account) AND assistant_pool_account(p_account);
	BEGIN
		IF v_counted = v_should THEN
			RETURN CASE WHEN v_counted THEN 'in' ELSE 'out' END;
		END IF;
		IF v_should THEN
			INSERT INTO assistant_pool_member (billing_account_id) VALUES (p_account);
			PERFORM assistant_pool_add(p_account, 1);
			RETURN 'added';
		END IF;
		PERFORM assistant_pool_add(p_account, -1);
		DELETE FROM assistant_pool_member WHERE billing_account_id = p_account;
		RETURN 'removed';
	END
	$$;
REVOKE ALL ON FUNCTION assistant_pool_sync(uuid) FROM PUBLIC;

-- A change of p_delta to an account's recorded cost in a UTC month. An
-- account no longer visible (being deleted) has nothing left to count.
CREATE FUNCTION assistant_month_count(p_account uuid, p_month date, p_delta bigint) RETURNS void
	LANGUAGE plpgsql VOLATILE SET search_path = public
	AS $$
	BEGIN
		IF p_account IS NULL OR coalesce(p_delta, 0) = 0 THEN
			RETURN;
		END IF;
		PERFORM assistant_counter_lock(p_account);
		IF NOT EXISTS (SELECT 1 FROM billing_account WHERE id = p_account) THEN
			RETURN;
		END IF;
		INSERT INTO assistant_month_counter (billing_account_id, month, cost_usd_micros) VALUES (p_account, p_month, p_delta)
			ON CONFLICT (billing_account_id, month) DO UPDATE SET cost_usd_micros = assistant_month_counter.cost_usd_micros + EXCLUDED.cost_usd_micros;
		IF assistant_pool_sync(p_account) = 'in' THEN
			PERFORM assistant_pool_bump('month', p_month, p_delta);
		END IF;
	END
	$$;
REVOKE ALL ON FUNCTION assistant_month_count(uuid, date, bigint) FROM PUBLIC;

-- A change of p_delta to an account's recorded cost on a SAST day (the day row is already written).
CREATE FUNCTION assistant_day_count(p_account uuid, p_day date, p_delta bigint) RETURNS void
	LANGUAGE plpgsql VOLATILE SET search_path = public
	AS $$
	BEGIN
		IF p_account IS NULL OR coalesce(p_delta, 0) = 0 THEN
			RETURN;
		END IF;
		PERFORM assistant_counter_lock(p_account);
		IF assistant_pool_sync(p_account) = 'in' THEN
			PERFORM assistant_pool_bump('day', p_day, p_delta);
		END IF;
	END
	$$;
REVOKE ALL ON FUNCTION assistant_day_count(uuid, date, bigint) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Triggers (definer: a project is deleted, and a subscription written, by
-- callers that can't see the counters)
-- ---------------------------------------------------------------------------

CREATE FUNCTION assistant_usage_counted() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF TG_OP = 'UPDATE' AND (OLD.project_id <> NEW.project_id OR OLD.month <> NEW.month) THEN
			RAISE EXCEPTION 'assistant_usage: a row never moves to another project or month (361 counts it where it is)';
		END IF;
		-- A project being deleted took its rows out of the counters first (assistant_project_counted), and is no longer visible.
		IF TG_OP = 'INSERT' THEN
			PERFORM assistant_month_count((SELECT billing_account_id FROM project WHERE id = NEW.project_id), NEW.month, NEW.cost_usd_micros);
		ELSIF TG_OP = 'UPDATE' THEN
			PERFORM assistant_month_count((SELECT billing_account_id FROM project WHERE id = NEW.project_id), NEW.month, NEW.cost_usd_micros - OLD.cost_usd_micros);
		ELSE
			PERFORM assistant_month_count((SELECT billing_account_id FROM project WHERE id = OLD.project_id), OLD.month, -OLD.cost_usd_micros);
		END IF;
		RETURN NULL;
	END
	$$;
REVOKE ALL ON FUNCTION assistant_usage_counted() FROM PUBLIC;

CREATE TRIGGER assistant_usage_counted_ins AFTER INSERT ON assistant_usage
	FOR EACH ROW WHEN (NEW.cost_usd_micros <> 0) EXECUTE FUNCTION assistant_usage_counted();
CREATE TRIGGER assistant_usage_counted_upd AFTER UPDATE ON assistant_usage
	FOR EACH ROW WHEN (OLD.cost_usd_micros IS DISTINCT FROM NEW.cost_usd_micros OR OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.month IS DISTINCT FROM NEW.month)
	EXECUTE FUNCTION assistant_usage_counted();
CREATE TRIGGER assistant_usage_counted_del AFTER DELETE ON assistant_usage
	FOR EACH ROW WHEN (OLD.cost_usd_micros <> 0) EXECUTE FUNCTION assistant_usage_counted();

CREATE FUNCTION assistant_day_usage_counted() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF TG_OP = 'UPDATE' AND (OLD.billing_account_id <> NEW.billing_account_id OR OLD.day <> NEW.day) THEN
			RAISE EXCEPTION 'assistant_day_usage: a row never moves to another account or day (361 counts it where it is)';
		END IF;
		IF TG_OP = 'INSERT' THEN
			PERFORM assistant_day_count(NEW.billing_account_id, NEW.day, NEW.cost_usd_micros);
		ELSIF TG_OP = 'UPDATE' THEN
			PERFORM assistant_day_count(NEW.billing_account_id, NEW.day, NEW.cost_usd_micros - OLD.cost_usd_micros);
		ELSE
			PERFORM assistant_day_count(OLD.billing_account_id, OLD.day, -OLD.cost_usd_micros);
		END IF;
		RETURN NULL;
	END
	$$;
REVOKE ALL ON FUNCTION assistant_day_usage_counted() FROM PUBLIC;

-- A begin's message count (cost unchanged) fires nothing.
CREATE TRIGGER assistant_day_usage_counted_ins AFTER INSERT ON assistant_day_usage
	FOR EACH ROW WHEN (NEW.cost_usd_micros <> 0) EXECUTE FUNCTION assistant_day_usage_counted();
CREATE TRIGGER assistant_day_usage_counted_upd AFTER UPDATE ON assistant_day_usage
	FOR EACH ROW WHEN (OLD.cost_usd_micros IS DISTINCT FROM NEW.cost_usd_micros OR OLD.billing_account_id IS DISTINCT FROM NEW.billing_account_id OR OLD.day IS DISTINCT FROM NEW.day)
	EXECUTE FUNCTION assistant_day_usage_counted();
CREATE TRIGGER assistant_day_usage_counted_del AFTER DELETE ON assistant_day_usage
	FOR EACH ROW WHEN (OLD.cost_usd_micros <> 0) EXECUTE FUNCTION assistant_day_usage_counted();

-- A project moving account (or losing it, when its account is deleted) moves
-- its usage's cost with it; a project being deleted takes it out before its
-- usage rows cascade away.
CREATE FUNCTION assistant_project_counted() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_old uuid := OLD.billing_account_id;
		v_new uuid := CASE WHEN TG_OP = 'UPDATE' THEN NEW.billing_account_id END;
		v_row record;
	BEGIN
		IF v_old IS DISTINCT FROM v_new THEN
			-- Both accounts' locks, in one order.
			PERFORM assistant_counter_lock(a) FROM unnest(ARRAY[v_old, v_new]) a WHERE a IS NOT NULL ORDER BY a;
			FOR v_row IN
				SELECT u.month, sum(u.cost_usd_micros)::bigint AS usd FROM assistant_usage u
				WHERE u.project_id = OLD.id GROUP BY u.month HAVING sum(u.cost_usd_micros) <> 0
			LOOP
				PERFORM assistant_month_count(v_old, v_row.month, -v_row.usd);
				PERFORM assistant_month_count(v_new, v_row.month, v_row.usd);
			END LOOP;
		END IF;
		RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NULL END;
	END
	$$;
REVOKE ALL ON FUNCTION assistant_project_counted() FROM PUBLIC;

CREATE TRIGGER assistant_project_counted_del BEFORE DELETE ON project
	FOR EACH ROW WHEN (OLD.billing_account_id IS NOT NULL) EXECUTE FUNCTION assistant_project_counted();
CREATE TRIGGER assistant_project_counted_upd AFTER UPDATE OF billing_account_id ON project
	FOR EACH ROW WHEN (OLD.billing_account_id IS DISTINCT FROM NEW.billing_account_id) EXECUTE FUNCTION assistant_project_counted();

-- A subscription change can move an account in or out of the pool.
CREATE FUNCTION assistant_subscription_counted() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_account uuid;
	BEGIN
		FOR v_account IN
			SELECT DISTINCT a FROM unnest(ARRAY[
				CASE WHEN TG_OP <> 'INSERT' THEN OLD.billing_account_id END,
				CASE WHEN TG_OP <> 'DELETE' THEN NEW.billing_account_id END]) a
			WHERE a IS NOT NULL ORDER BY a
		LOOP
			PERFORM assistant_counter_lock(v_account);
			PERFORM assistant_pool_sync(v_account);
		END LOOP;
		RETURN NULL;
	END
	$$;
REVOKE ALL ON FUNCTION assistant_subscription_counted() FROM PUBLIC;

CREATE TRIGGER assistant_subscription_counted AFTER INSERT OR DELETE OR UPDATE OF status, plan_code, billing_account_id ON subscription
	FOR EACH ROW EXECUTE FUNCTION assistant_subscription_counted();

-- An account being deleted leaves the pool first: once it is gone, the
-- cascades from it (its day rows, its subscriptions, its projects' account)
-- find nothing left to count.
CREATE FUNCTION assistant_account_counted() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		PERFORM assistant_counter_lock(OLD.id);
		IF EXISTS (SELECT 1 FROM assistant_pool_member WHERE billing_account_id = OLD.id) THEN
			PERFORM assistant_pool_add(OLD.id, -1);
			DELETE FROM assistant_pool_member WHERE billing_account_id = OLD.id;
		END IF;
		RETURN OLD;
	END
	$$;
REVOKE ALL ON FUNCTION assistant_account_counted() FROM PUBLIC;

CREATE TRIGGER assistant_account_counted BEFORE DELETE ON billing_account
	FOR EACH ROW EXECUTE FUNCTION assistant_account_counted();

-- ---------------------------------------------------------------------------
-- Backfill (the counted tables are locked against writes above)
-- ---------------------------------------------------------------------------
INSERT INTO assistant_month_counter (billing_account_id, month, cost_usd_micros)
	SELECT p.billing_account_id, u.month, sum(u.cost_usd_micros)::bigint
	FROM assistant_usage u JOIN project p ON p.id = u.project_id
	WHERE p.billing_account_id IS NOT NULL
	GROUP BY 1, 2 HAVING sum(u.cost_usd_micros) <> 0;
INSERT INTO assistant_pool_member (billing_account_id)
	SELECT a.id FROM billing_account a
	WHERE assistant_pool_account(a.id)
		AND (EXISTS (SELECT 1 FROM assistant_month_counter c WHERE c.billing_account_id = a.id)
			OR EXISTS (SELECT 1 FROM assistant_day_usage d WHERE d.billing_account_id = a.id AND d.cost_usd_micros <> 0));
INSERT INTO assistant_pool_counter (period, start, cost_usd_micros)
	SELECT 'month', c.month, sum(c.cost_usd_micros)::bigint
	FROM assistant_month_counter c JOIN assistant_pool_member m USING (billing_account_id)
	GROUP BY c.month;
INSERT INTO assistant_pool_counter (period, start, cost_usd_micros)
	SELECT 'day', d.day, sum(d.cost_usd_micros)::bigint
	FROM assistant_day_usage d JOIN assistant_pool_member m USING (billing_account_id)
	GROUP BY d.day HAVING sum(d.cost_usd_micros) <> 0;

-- ---------------------------------------------------------------------------
-- The read: 336's columns, from the counters plus the reservations in flight,
-- in one statement (one snapshot).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assistant_dollars_spent(p_month date, p_day date, p_account uuid, p_user uuid)
	RETURNS TABLE (account_month bigint, member_month bigint, member_day bigint, member_day_messages bigint, pool_month bigint, pool_today bigint)
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		WITH res AS (
			-- Every reservation of the month or the day (the turns in flight).
			SELECT p.billing_account_id AS account, r.user_id, coalesce(r.reserved_usd_micros, 0) AS usd,
				r.month = p_month AS in_month, r.day IS NOT DISTINCT FROM p_day AS in_day
			FROM assistant_reservation r JOIN project p ON p.id = r.project_id
			WHERE r.month = p_month OR r.day = p_day
		), res_pool AS (
			SELECT a.account FROM (SELECT DISTINCT account FROM res WHERE account IS NOT NULL) a WHERE assistant_pool_account(a.account)
		), day_row AS (
			SELECT d.cost_usd_micros, d.messages FROM assistant_day_usage d
			WHERE d.billing_account_id = p_account AND d.day = p_day AND d.user_id = p_user
		)
		SELECT
			(coalesce((SELECT c.cost_usd_micros FROM assistant_month_counter c WHERE c.billing_account_id = p_account AND c.month = p_month), 0)
				+ coalesce((SELECT sum(usd) FROM res WHERE in_month AND account = p_account), 0))::bigint,
			(coalesce((SELECT sum(u.cost_usd_micros) FROM assistant_usage u JOIN project p ON p.id = u.project_id
					WHERE u.user_id = p_user AND u.month = p_month AND p.billing_account_id = p_account), 0)
				+ coalesce((SELECT sum(usd) FROM res WHERE in_month AND account = p_account AND user_id = p_user), 0))::bigint,
			(coalesce((SELECT cost_usd_micros FROM day_row), 0)
				+ coalesce((SELECT sum(usd) FROM res WHERE in_day AND account = p_account AND user_id = p_user), 0))::bigint,
			coalesce((SELECT messages FROM day_row), 0)::bigint,
			(coalesce((SELECT pc.cost_usd_micros FROM assistant_pool_counter pc WHERE pc.period = 'month' AND pc.start = p_month), 0)
				+ coalesce((SELECT sum(usd) FROM res WHERE in_month AND account IN (SELECT account FROM res_pool)), 0))::bigint,
			(coalesce((SELECT pc.cost_usd_micros FROM assistant_pool_counter pc WHERE pc.period = 'day' AND pc.start = p_day), 0)
				+ coalesce((SELECT sum(usd) FROM res WHERE in_day AND account IN (SELECT account FROM res_pool)), 0))::bigint
	$$;
REVOKE ALL ON FUNCTION assistant_dollars_spent(date, date, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_dollars_spent(date, date, uuid, uuid) FROM water_app;

-- As 336, and the counters of purged months and days go too (the usage and
-- day rows' deletion has already brought them to 0).
CREATE OR REPLACE FUNCTION app_purge_assistant(p_months integer) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_rate integer;
		v_usage integer;
		v_day integer;
		v_reserved integer;
		v_cutoff date;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker purges the assistant counters' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_months IS NULL OR p_months < 2 THEN
			RAISE EXCEPTION 'keep at least this month and the one before' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		PERFORM pg_advisory_xact_lock(hashtext('assistant_usage:all'));
		v_reserved := assistant_settle_expired();
		DELETE FROM assistant_rate WHERE window_start <= now() - interval '1 hour';
		GET DIAGNOSTICS v_rate = ROW_COUNT;
		v_cutoff := (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => p_months - 1))::date;
		DELETE FROM assistant_usage WHERE month < v_cutoff;
		GET DIAGNOSTICS v_usage = ROW_COUNT;
		DELETE FROM assistant_day_usage WHERE day < v_cutoff;
		GET DIAGNOSTICS v_day = ROW_COUNT;
		DELETE FROM assistant_month_counter WHERE month < v_cutoff;
		DELETE FROM assistant_pool_counter WHERE start < v_cutoff;
		RETURN v_rate + v_usage + v_day + v_reserved;
	END
	$$;
