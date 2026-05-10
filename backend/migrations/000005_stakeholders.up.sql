CREATE TABLE IF NOT EXISTS stakeholders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('opportunity','project')),
  entity_id    UUID NOT NULL,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('internal','external')),
  email        TEXT,
  phone        TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS stakeholders_entity_idx
  ON stakeholders (tenant_id, entity_type, entity_id);
