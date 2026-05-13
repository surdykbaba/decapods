-- Free-text "what they actually do here" — distinct from `roles` (RBAC bundles
-- that gate features). The colleagues list and HR pages now lead with this so
-- teammates see "Senior Product Engineer" instead of the permission slug
-- "engineer", which most non-admins don't recognise. Empty means "not set".
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title TEXT NOT NULL DEFAULT '';
