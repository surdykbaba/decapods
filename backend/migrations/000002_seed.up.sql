-- Seed: default tenant + admin user (password Admin@12345 hashed in app, but we
-- ship a precomputed argon2id hash so the dev seed boots without app).
INSERT INTO tenants (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'Acme Holdings', 'acme')
ON CONFLICT DO NOTHING;

INSERT INTO roles (id, tenant_id, name, description) VALUES
  ('11111111-0000-0000-0000-000000000001', NULL, 'super_admin', 'Full access'),
  ('11111111-0000-0000-0000-000000000002', NULL, 'ceo', 'Executive read + approvals'),
  ('11111111-0000-0000-0000-000000000003', NULL, 'finance', 'Finance ops'),
  ('11111111-0000-0000-0000-000000000004', NULL, 'business_dev', 'BD pipeline'),
  ('11111111-0000-0000-0000-000000000005', NULL, 'delivery_manager', 'Delivery'),
  ('11111111-0000-0000-0000-000000000006', NULL, 'project_manager', 'PM'),
  ('11111111-0000-0000-0000-000000000007', NULL, 'engineer', 'IC'),
  ('11111111-0000-0000-0000-000000000008', NULL, 'qa', 'QA'),
  ('11111111-0000-0000-0000-000000000009', NULL, 'auditor', 'Read-only audit'),
  ('11111111-0000-0000-0000-00000000000a', NULL, 'compliance_officer', 'Governance')
ON CONFLICT DO NOTHING;

-- The hash below corresponds to "Admin@12345" using the argon2id parameters
-- in internal/auth/password.go. In real deployments, run `go run ./cmd/seed`
-- which generates a fresh hash.
INSERT INTO users (id, tenant_id, email, full_name, password_hash, mfa_enabled)
VALUES (
  '22222222-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'admin@pgdp.local',
  'Acme Admin',
  '$argon2id$v=19$m=65536,t=3,p=2$REPLACE_ME_WITH_GENERATED_HASH$REPLACE_ME',
  false
) ON CONFLICT DO NOTHING;

INSERT INTO user_roles (user_id, role_id)
VALUES ('22222222-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;
