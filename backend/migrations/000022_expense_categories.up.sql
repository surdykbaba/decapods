-- Per-expense category + currency so finance can group spend correctly.
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS category  text NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS currency  text NOT NULL DEFAULT 'NGN',
  ADD COLUMN IF NOT EXISTS notes     text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS expenses_project_idx     ON expenses (project_id, incurred_on DESC);
CREATE INDEX IF NOT EXISTS expenses_category_idx    ON expenses (tenant_id, category);
