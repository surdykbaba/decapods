-- ===== Leave management module =====
-- Catalog of leave types per tenant. Seeded with sensible defaults below.
CREATE TABLE IF NOT EXISTS leave_types (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code           text NOT NULL,                              -- annual, sick, …
  name           text NOT NULL,
  paid           boolean NOT NULL DEFAULT true,
  default_days   numeric(5,1) NOT NULL DEFAULT 0,            -- per-year accrual
  max_carryover  numeric(5,1) NOT NULL DEFAULT 0,
  requires_docs  boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- Per-user balance per type per year. Accrued + carryover − used.
CREATE TABLE IF NOT EXISTS leave_balances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id   uuid NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year            int  NOT NULL,
  accrued_days    numeric(5,1) NOT NULL DEFAULT 0,
  carryover_days  numeric(5,1) NOT NULL DEFAULT 0,
  used_days       numeric(5,1) NOT NULL DEFAULT 0,
  notes           text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, leave_type_id, year)
);

-- Leave requests. status: draft|pending|approved|rejected|cancelled.
-- days is the inclusive working-day count (rough — public holidays not subtracted in MVP).
CREATE TABLE IF NOT EXISTS leave_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id),
  leave_type_id      uuid NOT NULL REFERENCES leave_types(id),
  start_date         date NOT NULL,
  end_date           date NOT NULL,
  days               numeric(5,1) NOT NULL,
  reason             text NOT NULL DEFAULT '',
  handover_notes     text NOT NULL DEFAULT '',
  backup_user_id     uuid REFERENCES users(id),
  supporting_docs    jsonb NOT NULL DEFAULT '[]'::jsonb,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('draft','pending','approved','rejected','cancelled')),
  decision_by        uuid REFERENCES users(id),
  decision_at        timestamptz,
  decision_comment   text,
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leave_requests_user_idx
  ON leave_requests (tenant_id, user_id, start_date DESC);
CREATE INDEX IF NOT EXISTS leave_requests_status_idx
  ON leave_requests (tenant_id, status, start_date)
  WHERE status IN ('pending','approved');
CREATE INDEX IF NOT EXISTS leave_requests_window_idx
  ON leave_requests (tenant_id, start_date, end_date)
  WHERE status = 'approved';

-- Public holidays so the calendar can mark non-working days.
CREATE TABLE IF NOT EXISTS public_holidays (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  observed_on date NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, observed_on, name)
);
CREATE INDEX IF NOT EXISTS public_holidays_idx
  ON public_holidays (tenant_id, observed_on);

-- Seed default leave types for every existing tenant.
INSERT INTO leave_types (tenant_id, code, name, paid, default_days, max_carryover, requires_docs)
SELECT t.id, x.code, x.name, x.paid, x.default_days, x.max_carryover, x.requires_docs
  FROM tenants t
 CROSS JOIN (VALUES
    ('annual',        'Annual leave',          true,  20.0, 5.0, false),
    ('sick',          'Sick leave',            true,  10.0, 0.0, true),
    ('emergency',     'Emergency leave',       true,   3.0, 0.0, false),
    ('compassionate', 'Compassionate leave',   true,   5.0, 0.0, false),
    ('parental',      'Maternity / paternity', true,  90.0, 0.0, true),
    ('study',         'Study leave',           true,   5.0, 0.0, false),
    ('remote',        'Remote work day',       true,   0.0, 0.0, false),
    ('unpaid',        'Unpaid leave',          false,  0.0, 0.0, false)
 ) AS x(code, name, paid, default_days, max_carryover, requires_docs)
ON CONFLICT (tenant_id, code) DO NOTHING;
