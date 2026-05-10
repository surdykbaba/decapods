-- Two-stage approval (line manager → HR) for leave requests.
-- approval_stage drives the workflow while leave_requests.status remains the
-- end-state ("pending" until both stages clear). approvals is an audit log of
-- every decision (manager + HR + cancellations).
ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS approval_stage text NOT NULL DEFAULT 'manager_pending'
    CHECK (approval_stage IN ('manager_pending','hr_pending','completed')),
  ADD COLUMN IF NOT EXISTS approvals jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS duration text NOT NULL DEFAULT 'full_day'
    CHECK (duration IN ('full_day','half_day_am','half_day_pm'));

-- Backfill: previously-pending rows enter manager_pending; previously-decided
-- rows are already done.
UPDATE leave_requests SET approval_stage = 'completed'
 WHERE status IN ('approved','rejected','cancelled');
