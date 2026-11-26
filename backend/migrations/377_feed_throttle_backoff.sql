-- 377_feed_throttle_backoff — a throttled feed backs off on its own floor and
-- honours the Retry-After the source sent (issue #877; docs/architecture.md
-- § Data feeds → Throttling, docs/data-sources.md § Polite clients).
--
-- Until now a fetch the source throttled (HTTP 429 or 503) stored a message
-- the scheduler didn't read, so it backed off 15 min × 2^(failures − 1) like
-- any failure, whatever Retry-After asked, while a refusal (403) waits 2 h.
-- The fetch now stores (feeds/errors.ts FeedThrottledError, feedErrorMessage)
--   the source is unreachable: HTTP 429: the source asked us to slow down
--   and to wait 2 minutes (Retry-After: 120 s), so the feed waits …
-- or "… but gave no Retry-After, …" when it named none or one we can't read.
--
-- app_feed_next_attempt (253_feed_source_ecmwf.sql, its latest definition)
-- is that body with one change, the failure backoff:
--   * a throttle (the stored message matches
--     '^the source is unreachable: HTTP (429|503): the source asked us to
--     slow down', which also matches the messages stored before this
--     migration) waits 60 min × 2^(failures − 1), and at least the
--     "Retry-After: N s" its message names;
--   * a refusal keeps 2 h × 2^(failures − 1), anything else 15 min;
--   * all still capped at the day, less the tick's minute of slack, and the
--     schedule's own instant (the LEAST) still wins when it comes first.
-- The seconds are read only from our own fixed text (at most 9 digits,
-- http.ts retryAfterSeconds), so the cast can't fail.
--
-- app_feed_is_due calls this function and picks the change up without being
-- replaced. Same signature and STABLE as before, so CREATE OR REPLACE keeps
-- 243's grants (water_app EXECUTE, PUBLIC revoked); search_path stays
-- pinned. No table, policy, RLS or grant changes.

CREATE OR REPLACE FUNCTION app_feed_next_attempt(p_source text, p_schedule text, p_failures integer, p_last timestamptz, p_last_error text)
	RETURNS timestamptz
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT CASE WHEN p_last IS NULL THEN NULL ELSE LEAST(
			CASE WHEN p_source IN ('chirps_gefs', 'ecmwf_ens') THEN (
				SELECT CASE WHEN s > p_last THEN s ELSE s + interval '1 day' END
				FROM (
					SELECT (date_trunc('day', p_last AT TIME ZONE 'UTC')
						+ CASE WHEN p_source = 'chirps_gefs' THEN interval '8 hours 45 minutes' ELSE interval '14 hours' END) AT TIME ZONE 'UTC' AS s
				) slot
			)
			ELSE p_last + interval '1 day' - interval '1 minute'
			END,
			CASE WHEN p_failures > 0 THEN (
				SELECT p_last - interval '1 minute' + LEAST(
					interval '1 day',
					GREATEST(
						make_interval(mins => CASE
							WHEN starts_with(e, 'the source refused this server’s requests') THEN 120
							WHEN throttled THEN 60
							ELSE 15 END
							* power(2, LEAST(p_failures, 10) - 1)::integer),
						-- GREATEST ignores NULL: no Retry-After, or not a throttle, leaves the backoff.
						CASE WHEN throttled THEN make_interval(secs => substring(e FROM 'Retry-After: ([0-9]{1,9}) s')::double precision) END
					)
				)
				FROM (SELECT coalesce(p_last_error, '') AS e) err,
					LATERAL (SELECT e ~ '^the source is unreachable: HTTP (429|503): the source asked us to slow down' AS throttled) t
			) END
		) END
	$$;
