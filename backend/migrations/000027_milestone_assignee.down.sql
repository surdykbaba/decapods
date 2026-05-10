DROP INDEX IF EXISTS idx_milestones_assignee;
ALTER TABLE milestones
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS assignee_id;
