-- HR personnel record — the sensitive "file on each staff member" the
-- Members table never carried. One row per user (1:1). Everything is
-- nullable: people fill it incrementally, and HR can complete it on a
-- teammate's behalf. Kept in its own table (not extra columns on users)
-- so the hot members/auth queries stay lean and access can be scoped
-- separately later.
CREATE TABLE IF NOT EXISTS user_personnel (
  user_id                uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nin                    text,
  blood_group            text,
  genotype               text,
  date_of_birth          date,
  gender                 text,
  marital_status         text,
  home_address           text,
  personal_email         text,
  personal_phone         text,
  -- Emergency contact
  emergency_name         text,
  emergency_phone        text,
  emergency_relationship text,
  -- Next of kin
  nok_name               text,
  nok_phone              text,
  nok_relationship       text,
  nok_address            text,
  -- Guarantor
  guarantor_name         text,
  guarantor_phone        text,
  guarantor_email        text,
  guarantor_address      text,
  guarantor_occupation   text,
  guarantor_relationship text,
  -- Payroll basics (HR-relevant; visible to HR + the owner only)
  bank_name              text,
  bank_account_number    text,
  bank_account_name      text,
  notes                  text,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Personnel documents — CV, NIN slip, ID card, certificates. Bytes live
-- inline as bytea, mirroring project_files: cheap, tenant-clean, trivial
-- to back up. kind drives the upload slots in the UI.
CREATE TABLE IF NOT EXISTS user_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'other'
                 CHECK (kind IN ('cv','nin_slip','id_card','certificate','contract','other')),
  name         text NOT NULL,
  mime         text,
  size_bytes   bigint NOT NULL DEFAULT 0,
  content      bytea NOT NULL,
  uploaded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_documents_user_idx
  ON user_documents (user_id, created_at DESC);
