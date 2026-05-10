-- Manual presence override. Lets a user explicitly set their badge to
-- online / away / busy / invisible regardless of what the auto-derived
-- last_seen_at heartbeat says. NULL or 'auto' means "use the heartbeat".
--
-- Behaviour rules implemented in /presence and /me handlers:
--   manual_status = 'invisible'  → appear offline to everyone (heartbeat
--                                  still updates last_seen_at so we know they
--                                  were actually around, but presence reports
--                                  "offline")
--   manual_status in (online, away, busy) → forces the badge to that value,
--                                  overriding the auto-derived one
--   manual_status_until → optional auto-revert time (e.g. busy until 5pm)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS manual_status TEXT,
  ADD COLUMN IF NOT EXISTS manual_status_until TIMESTAMPTZ;

-- No constraint check — engine validates the enum at write time so old rows
-- with NULL stay valid forever.
