-- Down is a no-op — we can't tell which last_login_at values came from
-- the backfill vs an actual login event after the fix landed, and
-- clearing every row would erase real signal. Roll back the migration
-- with a manual NULL update if absolutely needed.
SELECT 1;
