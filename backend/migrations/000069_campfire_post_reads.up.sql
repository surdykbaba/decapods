-- Read receipts for Campfire posts. We only surface the count for
-- announcement-kind posts in the UI, but the table is kind-agnostic so
-- the data is there if we want "seen by" on other kinds later.
CREATE TABLE IF NOT EXISTS campfire_post_reads (
  post_id   uuid        NOT NULL REFERENCES campfire_posts(id) ON DELETE CASCADE,
  user_id   uuid        NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_campfire_post_reads_post
  ON campfire_post_reads (post_id);
