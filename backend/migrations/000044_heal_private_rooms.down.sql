-- Heal-only migration — there's nothing meaningful to "undo." Leaving
-- created memberships in place because removing them would lock owners
-- out of their own rooms, which is exactly what 000044 prevented.
SELECT 1;
