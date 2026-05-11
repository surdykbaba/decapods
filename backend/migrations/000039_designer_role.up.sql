-- Add a Designer role. Mirrors engineer/qa as another IC role; permissions
-- default to project:read + task:write via the rbac.go fallback map so a
-- designer can pick up and update their tasks without extra grants.
INSERT INTO roles (id, tenant_id, name, description) VALUES
  ('11111111-0000-0000-0000-00000000000f', NULL, 'designer', 'Design IC — UX, visual, product design')
ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description;
