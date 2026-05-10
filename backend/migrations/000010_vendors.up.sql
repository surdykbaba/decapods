-- Vendor / sub-contractor onboarding. Used whenever an opportunity is delivered
-- partly or wholly by external parties — every external team line must trace
-- back to a vendor record that has at least basic onboarding (and ideally a
-- signed SLA) before the lead can move past contracting.

CREATE TABLE vendors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  legal_name      TEXT,
  kind            TEXT NOT NULL DEFAULT 'consultant',  -- consultant | agency | freelancer | supplier
  contact_name    TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  website         TEXT,
  country         TEXT,
  competencies    TEXT[] NOT NULL DEFAULT '{}',         -- e.g. {"engineering","compliance","design"}
  status          TEXT NOT NULL DEFAULT 'draft',        -- draft | onboarded | sla_signed | suspended
  sla_signed_at   TIMESTAMPTZ,
  sla_expires_at  TIMESTAMPTZ,
  notes           TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_vendors_tenant      ON vendors (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_vendors_status      ON vendors (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_vendors_competencies ON vendors USING gin (competencies);

CREATE TABLE vendor_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                          -- profile | tax_cert | insurance | sla | nda | portfolio | reference
  name          TEXT NOT NULL,
  object_key    TEXT NOT NULL,                          -- URL or storage key
  uploaded_by   UUID REFERENCES users(id),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_vendor_documents_vendor ON vendor_documents (vendor_id);
CREATE INDEX idx_vendor_documents_kind   ON vendor_documents (vendor_id, kind);

-- Opportunities gain a delivery-model column so we know whether the work is
-- being staffed in-house, outsourced, or mixed. Drives vendor enforcement.
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS delivery_model TEXT NOT NULL DEFAULT 'inhouse';
  -- values: inhouse | outsource | mixed
