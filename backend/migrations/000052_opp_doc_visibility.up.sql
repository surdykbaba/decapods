-- Per-document visibility for opportunity attachments. Empty / NULL means
-- "everyone with access to the opportunity can see it" — i.e. the previous
-- behaviour — so existing rows don't need a backfill. A non-empty array
-- restricts the document to the listed users, plus the uploader and any
-- governance:write role (those checks live in the handler, not here).
ALTER TABLE opportunity_documents
  ADD COLUMN IF NOT EXISTS visible_user_ids uuid[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS opportunity_documents_visible_user_ids_idx
  ON opportunity_documents USING gin (visible_user_ids);
