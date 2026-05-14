-- Track when a Campfire post was last edited so the SPA can render an
-- "(edited)" marker next to the timestamp. NULL means never edited.
ALTER TABLE campfire_posts ADD COLUMN IF NOT EXISTS edited_at timestamptz;

-- Same on comments — UpdateComment already exists but didn't stamp anything.
ALTER TABLE campfire_comments ADD COLUMN IF NOT EXISTS edited_at timestamptz;
