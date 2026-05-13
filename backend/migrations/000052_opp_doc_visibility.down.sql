DROP INDEX IF EXISTS opportunity_documents_visible_user_ids_idx;
ALTER TABLE opportunity_documents DROP COLUMN IF EXISTS visible_user_ids;
