DROP INDEX IF EXISTS idx_vendors_service_cat;
DROP INDEX IF EXISTS idx_vendors_risk_level;
ALTER TABLE vendors
  DROP COLUMN IF EXISTS last_activity_at,
  DROP COLUMN IF EXISTS risk_level,
  DROP COLUMN IF EXISTS service_category;
