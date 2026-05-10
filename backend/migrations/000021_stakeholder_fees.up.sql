-- Stakeholders can carry a fee/honorarium/commission. Treated as an expense
-- deduction against the project's budget in finance summaries.
ALTER TABLE stakeholders
  ADD COLUMN IF NOT EXISTS fee_amount   numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_currency text          NOT NULL DEFAULT 'NGN';

CREATE INDEX IF NOT EXISTS stakeholders_fee_idx
  ON stakeholders (tenant_id, entity_type, entity_id)
  WHERE fee_amount > 0;
