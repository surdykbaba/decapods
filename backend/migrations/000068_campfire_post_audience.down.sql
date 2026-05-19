DROP INDEX IF EXISTS idx_campfire_posts_audience;
ALTER TABLE campfire_posts DROP COLUMN IF EXISTS audience;
