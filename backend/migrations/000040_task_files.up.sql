-- Tag a file to a specific task. NULL means the file lives at the project
-- level (existing rows stay project-scoped). ON DELETE SET NULL keeps the
-- file when its task is removed — the attachment moves back to the project
-- bucket rather than vanishing.
ALTER TABLE project_files
  ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_project_files_task
  ON project_files (task_id, created_at DESC)
  WHERE deleted_at IS NULL AND task_id IS NOT NULL;
