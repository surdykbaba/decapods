-- Token-gated invitations so a vendor can self-complete their onboarding profile
-- without an authenticated session. The invitation carries the vendor row it
-- targets — accepting it patches that row and uploads docs against it.

CREATE TABLE vendor_invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_id   UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  message     TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX idx_vendor_invitations_token  ON vendor_invitations (token) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_vendor_invitations_vendor ON vendor_invitations (vendor_id);
