-- Payroll module. HR/Finance only (gated by the payroll:* permission and
-- the "payroll" nav-visibility section).
--
-- Three tables:
--   employee_compensation — current salary structure per person (1:1).
--   payroll_runs          — one run per pay period (YYYY-MM), with a
--                            draft → approved → paid lifecycle.
--   payslips              — immutable per-employee snapshot generated
--                            into a run. Statutory math (PAYE, pension,
--                            NHF) is frozen at generation so a later
--                            comp edit can't rewrite history.

CREATE TABLE IF NOT EXISTS employee_compensation (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  currency         text NOT NULL DEFAULT 'NGN',
  -- Monthly gross is the sum of basic + allowances; we store the parts so
  -- payslips can break it down and so the Nigerian Consolidated Relief
  -- Allowance can be derived from gross.
  basic_monthly    numeric(14,2) NOT NULL DEFAULT 0,
  -- {"housing": 50000, "transport": 30000, ...}
  allowances       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Statutory toggles. Pension (8% employee) is on by default; NHF
  -- (2.5%) is opt-in because not every employer enrols staff.
  pension_opt_in   boolean NOT NULL DEFAULT true,
  nhf_opt_in       boolean NOT NULL DEFAULT false,
  effective_from   date NOT NULL DEFAULT CURRENT_DATE,
  notes            text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period          text NOT NULL,                 -- 'YYYY-MM'
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','approved','paid')),
  currency        text NOT NULL DEFAULT 'NGN',
  gross_total     numeric(16,2) NOT NULL DEFAULT 0,
  deduction_total numeric(16,2) NOT NULL DEFAULT 0,
  net_total       numeric(16,2) NOT NULL DEFAULT 0,
  headcount       int NOT NULL DEFAULT 0,
  notes           text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period)
);

CREATE TABLE IF NOT EXISTS payslips (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id              uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_name       text NOT NULL DEFAULT '',
  currency            text NOT NULL DEFAULT 'NGN',
  basic               numeric(14,2) NOT NULL DEFAULT 0,
  allowances          jsonb NOT NULL DEFAULT '{}'::jsonb,
  gross               numeric(14,2) NOT NULL DEFAULT 0,
  paye                numeric(14,2) NOT NULL DEFAULT 0,
  pension             numeric(14,2) NOT NULL DEFAULT 0,
  nhf                 numeric(14,2) NOT NULL DEFAULT 0,
  other_deductions    numeric(14,2) NOT NULL DEFAULT 0,
  deductions_total    numeric(14,2) NOT NULL DEFAULT 0,
  net                 numeric(14,2) NOT NULL DEFAULT 0,
  working_days        int NOT NULL DEFAULT 0,
  unpaid_leave_days   int NOT NULL DEFAULT 0,
  bank_name           text,
  bank_account_number text,
  bank_account_name   text,
  flags               text[] NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, user_id)
);
CREATE INDEX IF NOT EXISTS payslips_run_idx ON payslips (run_id);
CREATE INDEX IF NOT EXISTS payroll_runs_tenant_idx ON payroll_runs (tenant_id, period DESC);
