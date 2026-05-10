ALTER TABLE stakeholders
  DROP COLUMN IF EXISTS fee_currency,
  DROP COLUMN IF EXISTS fee_amount;
