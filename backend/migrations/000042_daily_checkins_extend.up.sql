-- Extend daily_checkins with a yesterday recap + attachments. Backfills
-- aren't needed — empty defaults read fine for old rows.
ALTER TABLE daily_checkins
  ADD COLUMN IF NOT EXISTS yesterday_note text,
  ADD COLUMN IF NOT EXISTS attachments    jsonb NOT NULL DEFAULT '[]'::jsonb;
