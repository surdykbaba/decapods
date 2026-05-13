-- Poll votes table — votes live in their own table so we can audit who
-- voted what, enforce one-vote-per-option, and tally efficiently without
-- mutating the post's meta JSONB on every click.
--
-- The poll itself is a regular campfire_posts row with kind='poll' and
-- meta = { options: ["A","B",...], multi: bool, expires_at: "..." }.
-- That keeps the feed query unchanged; only the hydration step touches
-- this table.

CREATE TABLE IF NOT EXISTS campfire_poll_votes (
  post_id    uuid NOT NULL REFERENCES campfire_posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_idx int  NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id, option_idx)
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_post ON campfire_poll_votes(post_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user ON campfire_poll_votes(user_id);

-- Extend the kind CHECK constraint on campfire_posts to allow 'poll'.
-- The original migration enumerated the kinds inline; we drop+recreate
-- because Postgres doesn't have ALTER CONSTRAINT for CHECKs.
ALTER TABLE campfire_posts DROP CONSTRAINT IF EXISTS campfire_posts_kind_check;
ALTER TABLE campfire_posts ADD CONSTRAINT campfire_posts_kind_check
  CHECK (kind IN ('announcement','win','celebration','joiner','birthday','anniversary','note','update','poll'));
