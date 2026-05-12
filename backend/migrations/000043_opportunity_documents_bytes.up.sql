-- Promote opportunity_documents from a key-only pointer to a real file
-- store. New columns hold the binary inline (bytea), the original MIME
-- type for serving with the right Content-Type, the size for UI display,
-- and tenant_id for the standard scoping rule. Backfill tenant_id from
-- the parent opportunity so existing rows stay valid.

ALTER TABLE opportunity_documents
  ADD COLUMN IF NOT EXISTS tenant_id    uuid REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS content_type text,
  ADD COLUMN IF NOT EXISTS size_bytes   bigint,
  ADD COLUMN IF NOT EXISTS bytes        bytea;

UPDATE opportunity_documents d
   SET tenant_id = o.tenant_id
  FROM opportunities o
 WHERE d.opportunity_id = o.id AND d.tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_opportunity_documents_tenant
  ON opportunity_documents (tenant_id, opportunity_id);
