CREATE TABLE IF NOT EXISTS opportunity_workflows (
  tenant_id  UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  definition JSONB NOT NULL DEFAULT '{"transitions":[]}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id)
);
