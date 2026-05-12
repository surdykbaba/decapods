-- Heal any private rooms that landed between the 000043 schema change and
-- the application code that uses it — specifically:
--
--   1. Pin any NULL is_private values to false. The column is declared
--      NOT NULL DEFAULT false so this should be a no-op on a healthy
--      install — kept here defensively so a half-applied prior migration
--      can self-correct.
--
--   2. Ensure every private room's creator is on its roster. A race
--      between the application binary rolling out and the migration
--      finishing could leave a room with is_private=true and no
--      campfire_room_members row — which means the creator is locked
--      out of their own room. This INSERT…NOT EXISTS reconciles that.
--
-- Idempotent. Safe to re-run.

UPDATE campfire_rooms
   SET is_private = false
 WHERE is_private IS NULL;

INSERT INTO campfire_room_members (room_id, user_id, added_by)
SELECT r.id, r.created_by, r.created_by
  FROM campfire_rooms r
 WHERE r.is_private = true
   AND r.created_by IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM campfire_room_members m
      WHERE m.room_id = r.id AND m.user_id = r.created_by
   )
ON CONFLICT DO NOTHING;
