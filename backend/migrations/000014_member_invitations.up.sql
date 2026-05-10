-- Email-style invite flow for workspace members. Admin creates the invite,
-- the invitee opens the public link, sets their own password, and the
-- corresponding `users` row is provisioned in one transaction. Until accepted
-- the user does NOT exist — the directory stays clean.

CREATE TABLE member_invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  email       CITEXT NOT NULL,
  full_name   TEXT NOT NULL,
  roles       TEXT[] NOT NULL DEFAULT '{}',
  message     TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  accepted_user_id UUID REFERENCES users(id)
);

CREATE INDEX idx_member_invitations_token  ON member_invitations (token) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_member_invitations_email  ON member_invitations (tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
