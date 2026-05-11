-- Admin-set MFA enforcement. When mfa_required is true and the user hasn't
-- enrolled (mfa_enabled = false), the SPA shows a sticky "Set up MFA" prompt
-- on every load and the Members admin can see the gap.
--
-- Enrollment uses a pending secret stored on mfa_secrets so /me/mfa/begin
-- can be hit repeatedly without thrashing the live secret of an already-
-- enrolled user.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT false;

ALTER TABLE mfa_secrets
  ADD COLUMN IF NOT EXISTS pending_secret  text,
  ADD COLUMN IF NOT EXISTS pending_expires timestamptz;
