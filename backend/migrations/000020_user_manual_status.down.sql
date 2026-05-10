ALTER TABLE users
  DROP COLUMN IF EXISTS manual_status_until,
  DROP COLUMN IF EXISTS manual_status;
