DROP INDEX IF EXISTS expenses_category_idx;
DROP INDEX IF EXISTS expenses_project_idx;
ALTER TABLE expenses
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS currency,
  DROP COLUMN IF EXISTS category;
