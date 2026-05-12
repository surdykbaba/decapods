DROP INDEX IF EXISTS idx_project_files_storage;

-- Restore the NOT NULL on content. This will fail if any sharepoint-stored
-- rows exist; that's intentional — rolling back this migration with
-- SharePoint-only rows would lose those files.
ALTER TABLE project_files
  ALTER COLUMN content SET NOT NULL;

ALTER TABLE project_files
  DROP COLUMN IF EXISTS sharepoint_web_url,
  DROP COLUMN IF EXISTS sharepoint_item_id,
  DROP COLUMN IF EXISTS sharepoint_drive_id,
  DROP COLUMN IF EXISTS sharepoint_site_id,
  DROP COLUMN IF EXISTS storage_kind;
