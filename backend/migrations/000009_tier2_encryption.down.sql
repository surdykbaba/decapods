DROP INDEX IF EXISTS stakeholders_email_hash_idx;
DROP INDEX IF EXISTS opportunity_documents_object_key_hash_idx;

ALTER TABLE opportunities
  DROP COLUMN IF EXISTS proposal_summary_sealed,
  DROP COLUMN IF EXISTS technical_scope_sealed,
  DROP COLUMN IF EXISTS metadata_sealed,
  DROP COLUMN IF EXISTS key_version;

ALTER TABLE projects
  DROP COLUMN IF EXISTS metadata_sealed,
  DROP COLUMN IF EXISTS key_version;

ALTER TABLE stakeholders
  DROP COLUMN IF EXISTS email_sealed,
  DROP COLUMN IF EXISTS phone_sealed,
  DROP COLUMN IF EXISTS notes_sealed,
  DROP COLUMN IF EXISTS email_hash,
  DROP COLUMN IF EXISTS key_version;

ALTER TABLE clients
  DROP COLUMN IF EXISTS contact_sealed,
  DROP COLUMN IF EXISTS key_version;

ALTER TABLE invoices
  DROP COLUMN IF EXISTS notes_sealed,
  DROP COLUMN IF EXISTS metadata_sealed,
  DROP COLUMN IF EXISTS key_version;

ALTER TABLE opportunity_documents
  DROP COLUMN IF EXISTS object_key_sealed,
  DROP COLUMN IF EXISTS object_key_hash,
  DROP COLUMN IF EXISTS key_version;
