DROP INDEX IF EXISTS idx_campfire_room_members_user;
DROP TABLE IF EXISTS campfire_room_members;
ALTER TABLE campfire_rooms
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS is_private;
