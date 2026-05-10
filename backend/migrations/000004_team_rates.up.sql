ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS team_composition JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS team_rates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('internal','external')),
  daily_rate  NUMERIC(12,2) NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

INSERT INTO team_rates (tenant_id, name, kind, daily_rate, currency)
SELECT t.id, r.name, r.kind, r.daily_rate, 'USD'
FROM tenants t
CROSS JOIN (VALUES
  ('Project manager',  'internal',  450),
  ('Delivery manager', 'internal',  500),
  ('Engineer',         'internal',  400),
  ('Senior engineer',  'internal',  600),
  ('QA',               'internal',  300),
  ('Designer',         'internal',  400),
  ('Compliance officer','internal', 500),
  ('Contract engineer','external',  800),
  ('Subject matter expert','external', 1200)
) AS r(name, kind, daily_rate)
ON CONFLICT (tenant_id, name) DO NOTHING;
