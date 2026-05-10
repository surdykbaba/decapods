DROP INDEX IF EXISTS idx_outbox_user_unread;
ALTER TABLE notification_outbox DROP COLUMN IF EXISTS read_at;
