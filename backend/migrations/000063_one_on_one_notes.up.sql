-- Persistent notes pane for the 1-on-1 dialog. One row per
-- (manager, report) pair — both parties see the same canvas so prep
-- and follow-ups land in one place. History across sessions is logged
-- in one_on_one_sessions so the rolling pane never erases the past.
CREATE TABLE IF NOT EXISTS one_on_one_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  manager_id   uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  report_id    uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  body         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manager_id, report_id)
);

-- Append-only log of completed 1-on-1 sessions. Manager clicks "Save &
-- close" → we snapshot the current notes into a session row and clear
-- the rolling pane (or keep it; UX detail driven by the SPA). Lets us
-- render a "past 1-on-1s" timeline without losing anything.
CREATE TABLE IF NOT EXISTS one_on_one_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  manager_id  uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  report_id   uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  notes       text NOT NULL DEFAULT '',
  held_on     date NOT NULL DEFAULT CURRENT_DATE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS one_on_one_sessions_pair_idx
  ON one_on_one_sessions (manager_id, report_id, held_on DESC);
