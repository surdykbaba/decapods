-- Legals — the workspace's statutory + compliance document warehouse.
--
-- Goals:
--   1. Single place for NDAs, employee contracts, vendor MSAs, client
--      SOWs, IP-assignment letters, regulatory filings, policies, etc.
--   2. Tied to a project when relevant (per-project client contract),
--      to a counterparty member when relevant (employee contract), or
--      to a workspace-wide entity (HR policy).
--   3. Expiry-aware so the dashboard can warn before things lapse.
--   4. File payload stored as bytea (matches project_files / opportunity_
--      documents patterns) so we don't need a separate object store for v1.
--
-- The list of categories is enumerated in code (see legals.go) rather
-- than via a DB enum, so adding a new category doesn't need a migration.

CREATE TABLE IF NOT EXISTS legal_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Classification + identity
  category        text NOT NULL,
  title           text NOT NULL,
  party           text,                                     -- counterparty (company / individual)
  reference_no    text,                                     -- contract ref, policy code, etc.

  -- Relations — all nullable; a doc belongs to whichever subset applies.
  project_id      uuid REFERENCES projects(id)  ON DELETE SET NULL,
  user_id         uuid REFERENCES users(id)     ON DELETE SET NULL,  -- subject (e.g. employee contract)
  vendor_id       uuid REFERENCES vendors(id)   ON DELETE SET NULL,  -- vendor MSA, supplier doc

  -- Lifecycle
  status          text NOT NULL DEFAULT 'active',           -- active | draft | expired | terminated
  effective_date  date,
  expires_at      date,
  signed_at       timestamptz,
  signed_by       uuid REFERENCES users(id) ON DELETE SET NULL,

  -- Payload
  filename        text,
  content_type    text,
  size_bytes      bigint NOT NULL DEFAULT 0,
  content         bytea,                                    -- nullable: link-only docs (e.g. SharePoint URL) skip the upload
  external_url    text,                                     -- alternative to content

  -- Metadata
  notes           text,
  tags            text[] NOT NULL DEFAULT '{}',
  version         int NOT NULL DEFAULT 1,
  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_legal_tenant_category ON legal_documents(tenant_id, category);
CREATE INDEX IF NOT EXISTS idx_legal_tenant_status   ON legal_documents(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_legal_expires         ON legal_documents(tenant_id, expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legal_project         ON legal_documents(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legal_user            ON legal_documents(user_id)    WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legal_vendor          ON legal_documents(vendor_id)  WHERE vendor_id IS NOT NULL;
