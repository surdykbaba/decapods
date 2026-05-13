-- Drops slot history. Down is destructive — once slots have been logged, the
-- info is gone. We accept that; the rule itself is reversible by simply
-- ignoring the column.
ALTER TABLE daily_checkins DROP COLUMN IF EXISTS slots_done;
