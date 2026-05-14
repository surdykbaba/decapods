-- Add 'blocked' as a first-class OKR status so the kanban can have a
-- column owners use to flag KRs that are stalled on a dependency. Sits
-- alongside in_progress; the SPA renders it red on the dashboard so a
-- manager can spot it without opening the row.
--
-- Drop + recreate the CHECK constraint so the new value is accepted;
-- existing rows are unaffected.
ALTER TABLE okrs DROP CONSTRAINT IF EXISTS okrs_status_check;
ALTER TABLE okrs ADD CONSTRAINT okrs_status_check
  CHECK (status IN ('draft','in_progress','blocked','done','dropped'));

ALTER TABLE okr_checkins DROP CONSTRAINT IF EXISTS okr_checkins_status_check;
ALTER TABLE okr_checkins ADD CONSTRAINT okr_checkins_status_check
  CHECK (status IS NULL OR status IN ('draft','in_progress','blocked','done','dropped'));
