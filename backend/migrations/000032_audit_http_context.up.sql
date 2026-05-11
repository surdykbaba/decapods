-- Capture the network/request context for every audit row so the system audit
-- trail can answer "who did what, from where, against which endpoint." Nullable
-- because background workers and pre-auth events (e.g. login failures) don't
-- always have all four.
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS ip             text,
  ADD COLUMN IF NOT EXISTS user_agent     text,
  ADD COLUMN IF NOT EXISTS request_method text,
  ADD COLUMN IF NOT EXISTS request_path   text;

CREATE INDEX IF NOT EXISTS audit_actor_created_idx ON audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_action_created_idx ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_ip_created_idx ON audit_log (ip, created_at DESC);
