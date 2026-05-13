-- Channel invite links — owner / admin generates a shareable token that
-- another tenant member can use to join a private channel without going
-- through the per-member roster picker. One row per active link.
--
-- Token is the public artifact; we store it raw because invite acceptance
-- already needs a logged-in session so the threat model is "share the URL"
-- not "leak the database". A revoked or expired link is denied at the
-- accept endpoint.

CREATE TABLE IF NOT EXISTS campfire_room_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     uuid NOT NULL REFERENCES campfire_rooms(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  created_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  max_uses    int,
  uses        int NOT NULL DEFAULT 0,
  revoked_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_campfire_invites_room ON campfire_room_invites(room_id);
CREATE INDEX IF NOT EXISTS idx_campfire_invites_token ON campfire_room_invites(token);
