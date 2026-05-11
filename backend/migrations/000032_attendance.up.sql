-- Attendance — session-based presence log derived from heartbeats.
--
-- A "session" is a contiguous block of activity: heartbeats arriving < 10 min
-- apart extend the current session, otherwise a new one is opened. Endpoint
-- code does the upsert from /me/heartbeat so there's no separate worker.
--
-- This table is the single source of truth for HR-side attendance insights:
-- daily hours-online, late starts, end-of-day signal, device split, etc.

CREATE TABLE IF NOT EXISTS attendance_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  started_at   timestamptz NOT NULL DEFAULT now(),
  -- Set on every heartbeat. The session is considered "open" while
  -- last_seen_at is within IDLE_GAP minutes of now().
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Device/platform fingerprint captured from the request — UA-parsed at
  -- write time, plus optional fields the client sends (timezone, locale,
  -- screen).
  user_agent   text,
  ip_address   inet,
  platform     text,        -- desktop | mobile | tablet | bot | other
  os           text,        -- macOS | Windows | Linux | iOS | Android
  browser      text,        -- Chrome | Safari | Firefox | Edge | other
  timezone     text,        -- client-reported IANA tz e.g. "Europe/Lagon"
  locale       text,        -- e.g. "en-GB"
  screen       text,        -- e.g. "1920x1080"
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Workhorse indexes for the HR insights queries: latest-per-user, daily roll-up
-- and per-user history. The (user_id, last_seen_at DESC) one is used by the
-- heartbeat upsert path to find an open session in O(1).
CREATE INDEX IF NOT EXISTS idx_attendance_user_recent
  ON attendance_sessions (user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_tenant_day
  ON attendance_sessions (tenant_id, started_at DESC);
