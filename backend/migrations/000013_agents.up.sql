-- PR / Relationship agents — external introducers, advisers and consultants
-- whose value is *relationships*, not delivery. Onboarding leans heavily on
-- compliance (PEP / anti-bribery / conflict-of-interest) rather than capacity,
-- which is why this lives separate from `vendors`.

CREATE TABLE agents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  organization        TEXT,
  agent_type          TEXT NOT NULL DEFAULT 'relationship_agent',
    -- pr_consultant | relationship_agent | strategic_adviser | business_introducer
    -- government_relations | market_entry_partner | independent_consultant
  contact_name        TEXT,
  contact_email       TEXT,
  contact_phone       TEXT,
  region              TEXT,                                  -- e.g. West Africa, EU
  country             TEXT,
  sector_focus        TEXT[] NOT NULL DEFAULT '{}',          -- finance, energy, public_sector, etc.
  relationship_owner  UUID REFERENCES users(id),             -- internal account-owner
  status              TEXT NOT NULL DEFAULT 'draft',
    -- draft | onboarded | engaged | suspended | terminated
  risk_level          TEXT NOT NULL DEFAULT 'low',           -- low | medium | high | critical
  pep_flag            BOOLEAN NOT NULL DEFAULT false,        -- politically exposed person
  conflict_flag       BOOLEAN NOT NULL DEFAULT false,        -- known conflict of interest
  notes               TEXT,
  last_activity_at    TIMESTAMPTZ,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX idx_agents_tenant      ON agents (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_agents_status      ON agents (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_agents_risk        ON agents (tenant_id, risk_level) WHERE deleted_at IS NULL;
CREATE INDEX idx_agents_type        ON agents (tenant_id, agent_type) WHERE deleted_at IS NULL;
CREATE INDEX idx_agents_owner       ON agents (relationship_owner) WHERE deleted_at IS NULL;
CREATE INDEX idx_agents_sectors     ON agents USING gin (sector_focus);

CREATE TABLE agent_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
    -- nda | engagement_agreement | agent_declaration | conflict_of_interest | kyc
    -- company_registration | tax_info | bank_details | anti_bribery
    -- data_protection | approval_memo | other
  name        TEXT NOT NULL,
  object_key  TEXT NOT NULL,
  uploaded_by UUID REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_docs_agent ON agent_documents (agent_id);
CREATE INDEX idx_agent_docs_kind  ON agent_documents (agent_id, kind);

CREATE TABLE agent_invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  message     TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX idx_agent_invitations_token ON agent_invitations (token) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_agent_invitations_agent ON agent_invitations (agent_id);
