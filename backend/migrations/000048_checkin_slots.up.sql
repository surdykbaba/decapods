-- Track which of the three daily check-in slots (morning, afternoon, evening)
-- a member has filled today. The data model deliberately stays one row per
-- (user, day) — the latest save still wins for mood/notes — but the
-- slots_done array records each slot the user has logged so the SPA can
-- enforce the "three times per day, can't repeat a slot" rule that HR
-- asked for.
--
-- Missed slots (didn't log morning before noon, etc.) simply never appear
-- in slots_done. They can't be back-filled — that's by design; we want a
-- pulse not a journal.
ALTER TABLE daily_checkins
  ADD COLUMN IF NOT EXISTS slots_done text[] NOT NULL DEFAULT '{}';
