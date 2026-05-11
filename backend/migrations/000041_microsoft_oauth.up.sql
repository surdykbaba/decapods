-- Microsoft / Entra ID OAuth tokens, one row per user.
--
-- We persist the access token + refresh token + expiry so the meetings
-- endpoint can refresh without re-prompting the user. Scope is stored
-- alongside the token because Microsoft mints tokens for the scopes you
-- asked for, not necessarily all the ones the app registers.
--
-- One row per user (PK = user_id). Disconnecting just deletes the row;
-- next connect mints a new one.

CREATE TABLE IF NOT EXISTS ms_oauth_tokens (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  ms_account     text,                       -- userPrincipalName / email reported by Graph
  ms_oid         text,                       -- Microsoft object id, stable per user
  access_token   text NOT NULL,
  refresh_token  text NOT NULL,
  scope          text NOT NULL DEFAULT '',
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ms_oauth_tenant ON ms_oauth_tokens(tenant_id);
