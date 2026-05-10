-- HR-class system roles. The default permission map in
-- internal/auth/rbac.go already grants `hr` workforce:* + user:read; this
-- migration just makes the role visible in the workspace directory and
-- adds an hr_manager flavor with a broader brief (line management,
-- approvals, balance adjustments).
INSERT INTO roles (id, tenant_id, name, description) VALUES
  ('11111111-0000-0000-0000-00000000000b', NULL, 'hr',         'HR generalist'),
  ('11111111-0000-0000-0000-00000000000c', NULL, 'hr_manager', 'HR manager — people ops + approvals'),
  ('11111111-0000-0000-0000-00000000000d', NULL, 'coo',        'Chief Operating Officer'),
  ('11111111-0000-0000-0000-00000000000e', NULL, 'client_viewer', 'External client read-only')
ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description;
