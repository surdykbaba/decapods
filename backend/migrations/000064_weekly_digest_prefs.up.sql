-- Per-user opt-in for the Monday 7am weekly engagement digest. Default
-- false (opt-in only). last_sent_at lets the scheduler dedupe so a
-- restart doesn't re-blast the same Monday.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS weekly_digest_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS weekly_digest_last_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_users_weekly_digest_enabled
  ON users (weekly_digest_enabled) WHERE weekly_digest_enabled = true;
