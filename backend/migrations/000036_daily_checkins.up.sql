-- Morning huddle check-ins. One row per (user, day): the user lands a mood
-- and a short focus note, and (optionally) we cross-post it to Campfire so
-- the team has visibility on what each person is picking up. Past rows form
-- a trend that the Burnout dashboard can chart.
CREATE TABLE IF NOT EXISTS daily_checkins (
  tenant_id          uuid        NOT NULL REFERENCES tenants(id),
  user_id            uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day                date        NOT NULL,
  mood               text,
  focus_note         text,
  posted_to_campfire boolean     NOT NULL DEFAULT false,
  campfire_post_id   uuid        REFERENCES campfire_posts(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_daily_checkins_tenant_day
  ON daily_checkins (tenant_id, day DESC);
