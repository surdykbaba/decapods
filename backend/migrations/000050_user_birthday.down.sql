-- Reversible by design — dropping the column loses any birthdays members
-- have already filled in. That's a deliberate trade-off if rolling back.
ALTER TABLE users DROP COLUMN IF EXISTS birthday;
