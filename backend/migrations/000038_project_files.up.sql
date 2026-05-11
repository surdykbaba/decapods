-- project_files — first-class file attachments on a project, distinct from
-- opportunity-level statutory documents. Use this for change requests,
-- architecture schemas, scope notes, design review packs, etc.
--
-- Storage: file bytes live inline as bytea, capped at the application layer.
-- Cheap and tenant-clean for the workspace's expected volume; can move to
-- object storage later by replacing `content` with a key + signing flow.
--
-- Visibility:
--   workspace  — everyone in the tenant
--   team       — only project_members for this project (default)
--   leads      — only super_admin / ceo / coo / delivery_manager / project_manager
--   private    — only the uploader

CREATE TABLE IF NOT EXISTS project_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploaded_by  uuid NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  name         text NOT NULL,
  description  text,
  kind         text NOT NULL DEFAULT 'other'
                   CHECK (kind IN (
                     'architecture','change_request','scope','design',
                     'contract','spec','meeting_notes','reference','other'
                   )),
  visibility   text NOT NULL DEFAULT 'team'
                   CHECK (visibility IN ('workspace','team','leads','private')),
  tags         text[] NOT NULL DEFAULT '{}',
  mime         text,
  size_bytes   bigint NOT NULL,
  content      bytea  NOT NULL,
  -- Lightweight versioning: each new upload with the same name on the same
  -- project bumps the version. Old rows stay queryable via deleted_at IS NULL.
  version      int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_project_files_project_recent
  ON project_files (project_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_project_files_kind
  ON project_files (project_id, kind)
  WHERE deleted_at IS NULL;
