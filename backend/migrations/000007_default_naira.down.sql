ALTER TABLE opportunities ALTER COLUMN currency SET DEFAULT 'USD';
ALTER TABLE projects      ALTER COLUMN currency SET DEFAULT 'USD';
UPDATE team_rates
SET currency = 'USD',
    daily_rate = ROUND(daily_rate / 1500)
WHERE currency = 'NGN';
