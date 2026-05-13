-- Reporting hierarchy — every user can name a manager (their reporting
-- line). One column, nullable so the org can be filled in gradually
-- without breaking any user who hasn't been mapped yet.
--
-- ON DELETE SET NULL: if a manager leaves the workspace, their direct
-- reports get unmoored rather than cascading away. HR re-assigns from
-- the Members page.
--
-- Cycle prevention isn't enforced at the schema level — a CHECK that
-- walks an arbitrary-depth chain isn't expressible in a column
-- constraint. The Members API checks for cycles on every PATCH instead;
-- the worst that could happen at the DB layer is a self-referencing
-- row, which the API rejects with 400.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS manager_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_manager_id
  ON users(manager_id) WHERE manager_id IS NOT NULL;
