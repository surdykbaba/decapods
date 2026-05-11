ALTER TABLE mfa_secrets
  DROP COLUMN IF EXISTS pending_expires,
  DROP COLUMN IF EXISTS pending_secret;

ALTER TABLE users DROP COLUMN IF EXISTS mfa_required;
