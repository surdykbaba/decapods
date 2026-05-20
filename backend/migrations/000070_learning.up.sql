-- Learning & development. Designed to start as a curated link catalog
-- (paste URLs from LinkedIn Learning / Coursera / Pluralsight / Udemy /
-- YouTube / internal docs) and grow into a full LMS API integration
-- without a schema rewrite: every resource carries provider + external
-- ID metadata so a nightly catalog sync can later upsert provider rows
-- without breaking handcurated ones.

-- A single course / video / article / book / talk in the catalog.
-- `provider` is a free-form label today (linkedin_learning, coursera,
-- pluralsight, udemy, youtube, internal, other). The API integration
-- swap-in will add a CHECK constraint + sync state once we have
-- enterprise credentials.
CREATE TABLE IF NOT EXISTS learning_resources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'other',
  external_id     text,                              -- provider course ID once API is wired
  external_url    text NOT NULL,
  title           text NOT NULL,
  description     text,
  topic           text,                              -- e.g. 'security', 'sales', 'leadership'
  role_tags       text[] NOT NULL DEFAULT '{}',     -- engineer, pm, hr, finance — broad audience tags
  difficulty      text DEFAULT 'all' CHECK (difficulty IN ('all','beginner','intermediate','advanced')),
  duration_minutes int,
  added_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_learning_resources_tenant
  ON learning_resources (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_learning_resources_topic
  ON learning_resources (tenant_id, topic) WHERE deleted_at IS NULL;

-- Ordered curricula. A path is a sequence of resources for a role/level
-- ("New PM ramp", "Security foundations"). Managers assign paths to
-- their reports; the report works through them in order.
CREATE TABLE IF NOT EXISTS learning_paths (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  role        text,                                  -- target role/level, e.g. 'engineer:senior'
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_learning_paths_tenant
  ON learning_paths (tenant_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS learning_path_items (
  path_id     uuid NOT NULL REFERENCES learning_paths(id)     ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES learning_resources(id) ON DELETE CASCADE,
  position    int  NOT NULL DEFAULT 0,
  required    boolean NOT NULL DEFAULT true,
  PRIMARY KEY (path_id, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_learning_path_items_position
  ON learning_path_items (path_id, position);

-- Assignment + progress. One row per (user, resource OR path). A row
-- with path_id set tracks the whole path; rows with resource_id track
-- individual items (used either inside a path or for a one-off course
-- the user picks up on their own).
--
-- status: pending  → not started
--         in_progress → user marked "I'm doing this"
--         completed → user marked "done" (self-reported until API)
--         dropped   → abandoned, with optional reason
CREATE TABLE IF NOT EXISTS learning_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id   uuid REFERENCES learning_resources(id) ON DELETE CASCADE,
  path_id       uuid REFERENCES learning_paths(id) ON DELETE CASCADE,
  assigned_by   uuid REFERENCES users(id) ON DELETE SET NULL, -- NULL = self-assigned
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_progress','completed','dropped')),
  due_on        date,
  started_at    timestamptz,
  completed_at  timestamptz,
  hours_spent   numeric(5,2),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (resource_id IS NOT NULL OR path_id IS NOT NULL)
);
-- A given user shouldn't have two active rows for the same resource
-- or the same path — keeps "mark as doing" idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_learning_assignments_user_resource
  ON learning_assignments (user_id, resource_id)
  WHERE resource_id IS NOT NULL AND status <> 'dropped';
CREATE UNIQUE INDEX IF NOT EXISTS uq_learning_assignments_user_path
  ON learning_assignments (user_id, path_id)
  WHERE path_id IS NOT NULL AND status <> 'dropped';
CREATE INDEX IF NOT EXISTS idx_learning_assignments_user
  ON learning_assignments (user_id, status);
CREATE INDEX IF NOT EXISTS idx_learning_assignments_tenant
  ON learning_assignments (tenant_id, status);
