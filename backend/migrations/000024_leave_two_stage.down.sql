ALTER TABLE leave_requests
  DROP COLUMN IF EXISTS duration,
  DROP COLUMN IF EXISTS approvals,
  DROP COLUMN IF EXISTS approval_stage;
