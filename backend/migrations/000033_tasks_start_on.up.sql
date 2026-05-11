-- Add a start date to tasks so we can show "age" (days the task has been open)
-- next to the due date. Optional — falls back to created_at when unset.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_on date;
