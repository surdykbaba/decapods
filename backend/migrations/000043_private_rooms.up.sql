-- Private team rooms. is_private=false (default) keeps the existing
-- workspace-wide rooms working unchanged. When is_private=true, only rows
-- in campfire_room_members can read or post — enforced at the handler.
ALTER TABLE campfire_rooms
  ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);

-- Membership roster for private rooms. Public rooms ignore this table.
-- ON DELETE CASCADE on the room means removing a private room cleans up
-- its roster automatically.
CREATE TABLE IF NOT EXISTS campfire_room_members (
  room_id   uuid NOT NULL REFERENCES campfire_rooms(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  added_by  uuid REFERENCES users(id),
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_campfire_room_members_user
  ON campfire_room_members (user_id);
