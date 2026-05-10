-- Per-user read state on engine-dispatched events. The outbox already stores
-- everything we sent (immediate or queued for digest); adding a read_at lets
-- the in-app feed mark items as seen without losing the audit trail.
ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_outbox_user_unread
  ON notification_outbox (user_id, created_at DESC)
  WHERE read_at IS NULL;
