-- Default currency to Naira tenant-wide.
ALTER TABLE opportunities ALTER COLUMN currency SET DEFAULT 'NGN';
ALTER TABLE projects      ALTER COLUMN currency SET DEFAULT 'NGN';

-- Re-denominate existing seeded team rates from USD to NGN
-- (rough ~1500 NGN per USD as of 2026 — admins can tune in Settings).
UPDATE team_rates
SET currency = 'NGN',
    daily_rate = ROUND(daily_rate * 1500)
WHERE currency = 'USD';
