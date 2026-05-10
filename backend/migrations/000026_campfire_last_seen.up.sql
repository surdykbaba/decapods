-- Track per-user "last opened the campfire feed" so we can show an unread
-- badge on the top bar without a heavy join on every nav refresh.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS campfire_last_seen_at timestamptz NOT NULL DEFAULT 'epoch';
