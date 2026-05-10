-- Tier-2 application-side encryption companion columns.
-- Each `*_sealed` column carries the AES-256-GCM payload produced by
-- internal/crypto.Keyring.Encrypt — wire format:
--   [1 byte version] [12 byte nonce] [n bytes ciphertext+tag]
-- We keep the original plaintext columns during the cutover window so
-- the application can dual-write, then drop them in 000008 once every
-- row has been re-encrypted and confirmed.

-- Opportunities: proposal & technical scope, plus the metadata blob
-- (which carries risks/reports/audit_log on projects).
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS proposal_summary_sealed BYTEA,
  ADD COLUMN IF NOT EXISTS technical_scope_sealed  BYTEA,
  ADD COLUMN IF NOT EXISTS metadata_sealed         BYTEA;

-- Project metadata holds risks, reports, audit_log, checkpoints, links.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS metadata_sealed BYTEA;

-- Stakeholders: name + email + phone + notes are PII.
ALTER TABLE stakeholders
  ADD COLUMN IF NOT EXISTS email_sealed BYTEA,
  ADD COLUMN IF NOT EXISTS phone_sealed BYTEA,
  ADD COLUMN IF NOT EXISTS notes_sealed BYTEA,
  ADD COLUMN IF NOT EXISTS email_hash   BYTEA;  -- blind index for exact lookups

-- Clients: contact jsonb often holds emails, addresses, signing officers.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS contact_sealed BYTEA;

-- Invoices: amount stays numeric (we still need to SUM/aggregate), but
-- any free-text/metadata gets sealed.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS notes_sealed    BYTEA,
  ADD COLUMN IF NOT EXISTS metadata_sealed BYTEA;

-- Opportunity documents: object_key may be an S3 path or raw URL the
-- user pasted; treat it as sensitive and sign it for blind lookup.
ALTER TABLE opportunity_documents
  ADD COLUMN IF NOT EXISTS object_key_sealed BYTEA,
  ADD COLUMN IF NOT EXISTS object_key_hash   BYTEA;

CREATE INDEX IF NOT EXISTS stakeholders_email_hash_idx
  ON stakeholders (email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS opportunity_documents_object_key_hash_idx
  ON opportunity_documents (object_key_hash) WHERE object_key_hash IS NOT NULL;

-- Bookkeeping: track which key version sealed each row so rotations are
-- quick to inspect (`SELECT key_version, COUNT(*) FROM opportunities ...`).
ALTER TABLE opportunities       ADD COLUMN IF NOT EXISTS key_version SMALLINT;
ALTER TABLE projects            ADD COLUMN IF NOT EXISTS key_version SMALLINT;
ALTER TABLE stakeholders        ADD COLUMN IF NOT EXISTS key_version SMALLINT;
ALTER TABLE clients             ADD COLUMN IF NOT EXISTS key_version SMALLINT;
ALTER TABLE invoices            ADD COLUMN IF NOT EXISTS key_version SMALLINT;
ALTER TABLE opportunity_documents ADD COLUMN IF NOT EXISTS key_version SMALLINT;
