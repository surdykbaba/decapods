-- Heartbeat-driven presence. Bumped by `POST /me/heartbeat` from any tab while
-- the user is signed in and the document is visible. Three derived states:
--   online   — last_seen_at within 90 seconds
--   away     — within 5 minutes
--   offline  — older, or null

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_last_seen
  ON users (tenant_id, last_seen_at DESC NULLS LAST)
  WHERE deleted_at IS NULL;
