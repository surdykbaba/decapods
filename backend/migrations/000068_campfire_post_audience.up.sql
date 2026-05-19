-- Audience scoping for Campfire posts. Default 'workspace' preserves
-- today's all-hands behaviour; 'team' restricts a post to the author's
-- reporting line (manager + direct reports + peers under the same
-- manager) so HR / legal / sensitive updates aren't firm-wide.
ALTER TABLE campfire_posts
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'workspace'
    CHECK (audience IN ('workspace','team'));

CREATE INDEX IF NOT EXISTS idx_campfire_posts_audience
  ON campfire_posts (tenant_id, audience);
