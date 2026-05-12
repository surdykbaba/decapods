ALTER TABLE opportunity_documents
  DROP COLUMN IF EXISTS bytes,
  DROP COLUMN IF EXISTS size_bytes,
  DROP COLUMN IF EXISTS content_type,
  DROP COLUMN IF EXISTS tenant_id;
