-- Backfill users.last_login_at from last_seen_at.
--
-- Login + MFA-verify never wrote last_login_at before, so the Members
-- directory was stuck showing "Never" for every active user. The fix
-- to the handler is in auth.go; this migration repairs the historical
-- rows.
--
-- Rule: if the user has any heartbeat at all (last_seen_at IS NOT NULL)
-- they must have logged in at least once, so use last_seen_at as a
-- best-available proxy for the lost timestamp. Users who've never
-- shown a heartbeat stay NULL.

UPDATE users
   SET last_login_at = last_seen_at
 WHERE last_login_at IS NULL
   AND last_seen_at IS NOT NULL;
