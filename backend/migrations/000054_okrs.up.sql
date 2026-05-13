-- OKR Phase 1: cycles + objectives + key results.
--
-- Single okrs table for both objectives and their key results (kind
-- discriminates) so cascading "objective → key result" sits naturally
-- as a parent_id pointer. Phase 2 will add okr_checkins + alignment;
-- the parent_id column is included now so cascading later doesn't need
-- a follow-up migration that rewrites rows.

-- okr_cycles — quarterly (or any other shape) windows that OKRs roll up
-- into. Status lets HR move a cycle from planning → active → closed.
CREATE TABLE IF NOT EXISTS okr_cycles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  status      text NOT NULL DEFAULT 'active'
              CHECK (status IN ('planning','active','closed')),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS okr_cycles_tenant_status_idx
  ON okr_cycles (tenant_id, status);

-- okrs — the actual goal rows. kind='objective' rows have NULL parent_id;
-- kind='key_result' rows always have parent_id pointing at an objective
-- in the same cycle. owner_id is who's responsible (an objective can
-- belong to a user; KRs typically inherit from their parent but can be
-- assigned independently for shared work).
--
-- Progress model:
--   target_value + current_value + unit — quantitative ("ship 3 features")
--   When target_value is NULL the KR is qualitative; completion is
--   driven by status alone ('done' = 100%).
--   confidence is the owner's gut read (green/amber/red) updated on each
--   check-in. status is a coarse lifecycle.
CREATE TABLE IF NOT EXISTS okrs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cycle_id      uuid NOT NULL REFERENCES okr_cycles(id) ON DELETE CASCADE,
  parent_id     uuid REFERENCES okrs(id) ON DELETE CASCADE,
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('objective','key_result')),
  title         text NOT NULL,
  description   text,
  -- Quantitative fields. NULLable for qualitative key results that just
  -- want a "done / not done" lifecycle.
  target_value  numeric,
  current_value numeric NOT NULL DEFAULT 0,
  unit          text,
  confidence    text NOT NULL DEFAULT 'green'
                CHECK (confidence IN ('green','amber','red')),
  status        text NOT NULL DEFAULT 'in_progress'
                CHECK (status IN ('draft','in_progress','done','dropped')),
  position      int NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Hard rule: key_results must have a parent; objectives must not.
  CHECK (
    (kind = 'objective'  AND parent_id IS NULL) OR
    (kind = 'key_result' AND parent_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS okrs_tenant_cycle_idx       ON okrs (tenant_id, cycle_id);
CREATE INDEX IF NOT EXISTS okrs_owner_cycle_idx        ON okrs (owner_id,  cycle_id);
CREATE INDEX IF NOT EXISTS okrs_parent_idx             ON okrs (parent_id);
