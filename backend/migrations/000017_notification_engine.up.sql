-- Unified notification engine. Two tables drive the whole pipeline:
--
-- 1. notification_category_prefs — per-user, per-category overrides. Defaults
--    are baked into the event catalog in code; rows here are only written when
--    a user changes something. Missing row = use the catalog default.
--
-- 2. notification_outbox — every notification we *dispatched* (or would have
--    dispatched if SMTP were configured). Doubles as audit trail and the
--    digest source: the daily/weekly workers drain this table.

CREATE TABLE notification_category_prefs (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   TEXT NOT NULL,            -- "account" | "pipeline" | "delivery" | ...
  tier       TEXT NOT NULL DEFAULT 'immediate',  -- immediate | digest_daily | digest_weekly | off
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

CREATE TABLE notification_outbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  email         TEXT NOT NULL,                  -- snapshot at send-time
  event_kind    TEXT NOT NULL,                  -- e.g. "opportunity.submitted"
  category      TEXT NOT NULL,
  tier          TEXT NOT NULL,                  -- the tier this dispatch was queued under
  subject       TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',    -- structured event data for digest rendering
  link          TEXT,                           -- deep link into the app
  sent_at       TIMESTAMPTZ,                    -- NULL = pending (digest), set when actually emailed
  delivered     BOOLEAN NOT NULL DEFAULT false, -- mailer accepted (best-effort)
  error         TEXT,
  digest_id     UUID,                           -- groups events that were rolled into one digest
  dedupe_key    TEXT,                           -- "opportunity.submitted:<oppID>" — collapse same-event dups within 5 min
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_pending_user ON notification_outbox (user_id, tier, created_at)
  WHERE sent_at IS NULL;
-- Partial-index can't use now() (volatile). Lookup query supplies the time bound itself.
CREATE INDEX idx_outbox_dedupe ON notification_outbox (user_id, dedupe_key, created_at DESC)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_outbox_user_recent ON notification_outbox (user_id, created_at DESC);
