DROP INDEX IF EXISTS idx_project_files_task;
ALTER TABLE project_files DROP COLUMN IF EXISTS task_id;
