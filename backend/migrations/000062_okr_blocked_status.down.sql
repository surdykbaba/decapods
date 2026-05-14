-- Revert any blocked rows to in_progress so the older CHECK constraint
-- doesn't reject them, then narrow the constraint back.
UPDATE okrs SET status='in_progress' WHERE status='blocked';
UPDATE okr_checkins SET status='in_progress' WHERE status='blocked';

ALTER TABLE okrs DROP CONSTRAINT IF EXISTS okrs_status_check;
ALTER TABLE okrs ADD CONSTRAINT okrs_status_check
  CHECK (status IN ('draft','in_progress','done','dropped'));

ALTER TABLE okr_checkins DROP CONSTRAINT IF EXISTS okr_checkins_status_check;
ALTER TABLE okr_checkins ADD CONSTRAINT okr_checkins_status_check
  CHECK (status IS NULL OR status IN ('draft','in_progress','done','dropped'));
