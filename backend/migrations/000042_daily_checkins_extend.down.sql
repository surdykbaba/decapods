ALTER TABLE daily_checkins
  DROP COLUMN IF EXISTS yesterday_note,
  DROP COLUMN IF EXISTS attachments;
