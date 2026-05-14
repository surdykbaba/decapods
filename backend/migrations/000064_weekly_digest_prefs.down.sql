DROP INDEX IF EXISTS idx_users_weekly_digest_enabled;
ALTER TABLE users
  DROP COLUMN IF EXISTS weekly_digest_last_sent_at,
  DROP COLUMN IF EXISTS weekly_digest_enabled;
