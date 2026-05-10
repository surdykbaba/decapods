-- Round 2 of vendor model: classification + risk grading + the document kinds
-- needed for an enterprise compliance checklist. Does NOT add the deliverables /
-- risk register / payment tables yet — those land in 000012 once the UX for
-- them is settled. Keeping the migration narrow makes the rollback path safe.

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS service_category TEXT,                              -- e.g. compliance_advisory, engineering, training
  ADD COLUMN IF NOT EXISTS risk_level       TEXT NOT NULL DEFAULT 'low',       -- low | medium | high | critical
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;                       -- bumped whenever any vendor-scoped row is touched

CREATE INDEX IF NOT EXISTS idx_vendors_risk_level   ON vendors (tenant_id, risk_level)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vendors_service_cat  ON vendors (tenant_id, service_category)  WHERE deleted_at IS NULL;
