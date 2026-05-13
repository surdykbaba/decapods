-- Per-slot timestamps on daily_checkins.
--
-- Why: the dashboard wanted to surface "Checked in at 09:32" / "Checked
-- out at 18:11" per slot, but slots_done was just a text[] of slot keys
-- with no timing data. We could approximate from created_at / updated_at
-- but that only gives us first + last across all three slots, not
-- per-slot. A jsonb map fits the shape exactly: { morning: "...", … }.
--
-- Keeping it nullable-default-empty so existing rows don't need a
-- backfill; the SPA renders an em-dash when a slot is checked in
-- before this migration lands.

ALTER TABLE daily_checkins
  ADD COLUMN IF NOT EXISTS slot_times jsonb NOT NULL DEFAULT '{}'::jsonb;
