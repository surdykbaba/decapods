-- Milestones get an owner. They're starting to behave like top-level tasks —
-- something a PM hands to a specific person — so we add an assignee + a
-- description (the task-style "what does done look like" notes) without
-- collapsing the tasks table into them.
ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS description text;

CREATE INDEX IF NOT EXISTS idx_milestones_assignee ON milestones(assignee_id);
