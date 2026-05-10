-- Invoice Reference Number captured per invoice. Used by the IRN-lookup flow
-- in the create-invoice dialog: paste an IRN, fetch details from the
-- e-Invoicing provider (FIRS / equivalent) and pre-fill the form. For now we
-- store the value on the invoice and make it look-up-able by IRN; the live
-- fetch from FIRS plugs in via a separate handler when credentials are
-- provisioned.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS irn TEXT;

CREATE INDEX IF NOT EXISTS idx_invoices_irn ON invoices (tenant_id, irn) WHERE irn IS NOT NULL;
