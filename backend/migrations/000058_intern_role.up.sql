-- Intern role. Deliberately the smallest grant surface in the matrix: read
-- the projects they're added to, log their own time, update their own tasks,
-- and read OKRs (no writes — interns shouldn't be setting workspace
-- objectives). They do NOT get any finance / opportunity / workforce /
-- analytics / document-write scopes, so the BD pipeline, finance ledger,
-- workforce capacity (rates), invoices and audit logs stay invisible to
-- them by virtue of failing every permission gate on those routes.
INSERT INTO roles (id, tenant_id, name, description) VALUES
  ('11111111-0000-0000-0000-000000000010', NULL, 'intern', 'Intern / trainee — restricted, no access to financial, BD or workforce data')
ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description;
