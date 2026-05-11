DROP INDEX IF EXISTS audit_ip_created_idx;
DROP INDEX IF EXISTS audit_action_created_idx;
DROP INDEX IF EXISTS audit_actor_created_idx;
ALTER TABLE audit_log
  DROP COLUMN IF EXISTS request_path,
  DROP COLUMN IF EXISTS request_method,
  DROP COLUMN IF EXISTS user_agent,
  DROP COLUMN IF EXISTS ip;
