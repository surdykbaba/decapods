-- Contract / revenue model on an opportunity. Drives the governance pack:
-- a PPP concession (ppp_concession) routes through Nigeria's ICRC
-- regulatory pathway (Outline Business Case, OBC Compliance Certificate,
-- VfM analysis, transaction-adviser procurement), enforced as required
-- documents exactly like the NDA/SLA flow. Defaults to fixed_fee so every
-- existing row keeps its current (non-PPP) document requirements.
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS contract_model text NOT NULL DEFAULT 'fixed_fee';

ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_contract_model_check;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_contract_model_check
  CHECK (contract_model IN ('fixed_fee','time_materials','revenue_share','ppp_concession'));
