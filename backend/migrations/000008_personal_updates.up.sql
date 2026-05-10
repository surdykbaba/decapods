CREATE TABLE IF NOT EXISTS personal_updates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  project_id      UUID REFERENCES projects(id)        ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('daily','weekly','blocker','accomplishment','next_action','risk')),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  for_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS personal_updates_user_idx
  ON personal_updates (tenant_id, user_id, for_date DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS github_username TEXT;
