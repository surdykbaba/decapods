-- Avatar storage. We keep the encoded image inline (data URI) so we don't
-- need an object store for the MVP. Validated to a sane size on the way in.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url text;
