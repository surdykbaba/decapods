-- Foundation for routing project_files uploads to Microsoft SharePoint.
--
-- We add columns so a future upload handler can mint a Graph drive item and
-- record where the file actually lives, while existing bytea rows keep
-- working unchanged. NO data is migrated by this migration — every existing
-- row stays storage_kind='inline' with its bytea content.
--
-- storage_kind values:
--   inline      — bytes live in project_files.content (current behaviour)
--   sharepoint  — bytes live in a SharePoint drive; the columns below
--                 carry the reference. content may be empty.
ALTER TABLE project_files
  ADD COLUMN IF NOT EXISTS storage_kind         text NOT NULL DEFAULT 'inline'
    CHECK (storage_kind IN ('inline','sharepoint')),
  ADD COLUMN IF NOT EXISTS sharepoint_site_id   text,
  ADD COLUMN IF NOT EXISTS sharepoint_drive_id  text,
  ADD COLUMN IF NOT EXISTS sharepoint_item_id   text,
  ADD COLUMN IF NOT EXISTS sharepoint_web_url   text;

-- bytea content becomes optional once the SharePoint path is wired. Until
-- then the Upload handler always writes inline + NOT NULL is fine; we relax
-- the constraint here so the next migration doesn't have to.
ALTER TABLE project_files
  ALTER COLUMN content DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_files_storage
  ON project_files (storage_kind)
  WHERE deleted_at IS NULL;
