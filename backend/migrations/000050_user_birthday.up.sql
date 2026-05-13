-- Birthday on the user profile. Nullable — every member opts in.
--
-- Storage choice: text (YYYY-MM-DD) rather than a date column. Two reasons:
--   • Members who don't want to share their year can submit a sentinel
--     (1900-..) without lying about a date type. The matching code only
--     looks at month + day so the chime fires either way.
--   • Going through a text column lets the same value drive both the
--     Colleagues drawer (privacy-aware) and any future "anniversary"
--     style usage without column-shape churn.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS birthday text;
