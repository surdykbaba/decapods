-- OKR Phase 2: weekly check-ins + parent-objective cascade.
--
-- Each row in okr_checkins is one progress update on a single OKR
-- (objective or key result). The OKR itself still carries the current
-- value + confidence so list-views stay fast; check-ins are the history
-- log + the "what changed since last time" feed.
--
-- Two-way relationship:
--   • Writing a check-in updates okrs.current_value, .confidence and
--     .status (when the author bumps it) — done in the handler.
--   • The check-in row preserves the snapshot at that moment for the
--     history strip and any future audit / weekly digest.
CREATE TABLE IF NOT EXISTS okr_checkins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  okr_id      uuid NOT NULL REFERENCES okrs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Snapshot of progress at the moment of the check-in. For
  -- quantitative KRs, current_value is the canonical truth; percent is
  -- derived in the handler so the SPA doesn't need to know the target.
  -- For qualitative rows percent is the author's confidence on
  -- completion (0..100).
  current_value numeric,
  percent     int NOT NULL CHECK (percent BETWEEN 0 AND 100),
  confidence  text NOT NULL CHECK (confidence IN ('green','amber','red')),
  status      text CHECK (status IN ('draft','in_progress','done','dropped')),
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS okr_checkins_okr_created_idx
  ON okr_checkins (okr_id, created_at DESC);
CREATE INDEX IF NOT EXISTS okr_checkins_tenant_user_idx
  ON okr_checkins (tenant_id, user_id, created_at DESC);
