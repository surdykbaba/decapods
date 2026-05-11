-- Per-user dismissals for the in-app attention feed. Stores the *synthetic or
-- outbox* item id the bell uses (e.g. "task:overdue:<uuid>" or
-- "outbox:<uuid>"), so the same row can hide items regardless of source.
-- Synthetic items still auto-clear when their underlying state changes; this
-- table just lets the user hide one explicitly before that happens.
CREATE TABLE IF NOT EXISTS notification_dismissals (
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id      TEXT        NOT NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_notif_dismissals_user
  ON notification_dismissals (user_id, dismissed_at DESC);
