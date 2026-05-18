ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_contract_model_check;
ALTER TABLE opportunities DROP COLUMN IF EXISTS contract_model;
