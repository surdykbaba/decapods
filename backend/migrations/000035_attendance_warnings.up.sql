-- Attendance warnings — logged when a member's heartbeat gap during working
-- hours exceeds the configured threshold (default 30 min) and they aren't
-- on approved leave. HR gets pinged through the notification engine; the
-- row also feeds the appraisal Wellbeing/Attendance sub-score.
--
-- Detection runs lazily on the next heartbeat after the gap — when the
-- member comes back, the resume path inspects the previous session and
-- decides whether to log a warning. A periodic scan can be added later
-- to catch users who never resume during the work day.

CREATE TABLE IF NOT EXISTS attendance_warnings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  kind            text NOT NULL DEFAULT 'long_away',  -- long_away | offline_during_hours | other
  gap_minutes     int  NOT NULL,                       -- size of the away gap that tripped the rule
  started_at      timestamptz NOT NULL,                -- when the away gap began (= prev session last_seen)
  ended_at        timestamptz,                          -- when activity resumed (NULL = still away)
  work_hours_only boolean NOT NULL DEFAULT true,        -- gap was inside the work-hours window
  notified_at     timestamptz,                          -- HR notification dispatched at this time
  acknowledged_at timestamptz,                          -- HR explicitly acknowledged the warning
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_warnings_user_recent
  ON attendance_warnings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_warnings_tenant_unack
  ON attendance_warnings (tenant_id, created_at DESC)
  WHERE acknowledged_at IS NULL;
