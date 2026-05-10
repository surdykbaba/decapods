-- Campfire — the workspace's social layer. Posts, comments, reactions, kudos,
-- mood check-ins, help requests, and team chat rooms all live here. Kept in
-- one migration because the modules cross-reference each other (reactions
-- target posts/comments/messages/kudos via a polymorphic pair).

-- ──────────────────────────────────────────────────────────────────────────
-- Pulse feed: announcements, wins, joiners, birthdays, anniversaries, notes
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campfire_posts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  kind       text NOT NULL CHECK (kind IN (
    'announcement','win','celebration','joiner','birthday','anniversary','note','update'
  )),
  title      text,
  body       text NOT NULL,
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  pinned     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campfire_posts_tenant_time ON campfire_posts(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campfire_posts_pinned ON campfire_posts(tenant_id, pinned) WHERE pinned;

CREATE TABLE IF NOT EXISTS campfire_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  post_id    uuid NOT NULL REFERENCES campfire_posts(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campfire_comments_post ON campfire_comments(post_id, created_at);

-- Polymorphic reactions — same table serves posts, comments, messages, kudos.
-- target_type discriminates; each (target_type, target_id, user, emoji) is
-- unique so the same user can toggle a single emoji on/off.
CREATE TABLE IF NOT EXISTS campfire_reactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('post','comment','message','kudo')),
  target_id   uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_campfire_reactions_target ON campfire_reactions(target_type, target_id);

-- ──────────────────────────────────────────────────────────────────────────
-- Shout-outs & badges
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campfire_kudos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge        text NOT NULL CHECK (badge IN (
    'delivery_champion','problem_solver','team_player','fast_responder','client_hero','custom'
  )),
  message      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campfire_kudos_tenant_time ON campfire_kudos(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campfire_kudos_to ON campfire_kudos(to_user_id);

-- ──────────────────────────────────────────────────────────────────────────
-- Mood / pulse check (one per user per day; UPSERT in handler)
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campfire_mood (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        date NOT NULL,
  mood       text NOT NULL CHECK (mood IN ('great','good','neutral','stressed','overloaded')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_campfire_mood_tenant_day ON campfire_mood(tenant_id, day);

-- ──────────────────────────────────────────────────────────────────────────
-- Help / unblock requests
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campfire_help (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('help','blocked','review','devops','management')),
  title        text NOT NULL,
  body         text,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  resolver_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_campfire_help_tenant_status ON campfire_help(tenant_id, status, created_at DESC);

-- ──────────────────────────────────────────────────────────────────────────
-- Team rooms — lightweight chat channels
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campfire_rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  name        text NOT NULL,
  description text,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS campfire_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_id    uuid NOT NULL REFERENCES campfire_rooms(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campfire_messages_room_time ON campfire_messages(room_id, created_at DESC);

-- Seed default rooms for every existing tenant. New tenants will need a
-- migration trigger or app-level seeding, but for now this brings the
-- workspace to life immediately.
INSERT INTO campfire_rooms (tenant_id, slug, name, description, is_default)
SELECT t.id, r.slug, r.name, r.description, r.slug = 'general'
FROM tenants t
CROSS JOIN (VALUES
  ('general',     'General',     'Workspace-wide chat'),
  ('engineering', 'Engineering', 'Tech, builds, deploys'),
  ('delivery',    'Delivery',    'Project delivery & ops'),
  ('product',     'Product',     'Roadmap, design, research'),
  ('finance',     'Finance',     'Invoices, budgets, billing'),
  ('hr',          'HR',          'People, hiring, policy'),
  ('random',      'Random',      'Off-topic — the watercooler')
) AS r(slug, name, description)
ON CONFLICT (tenant_id, slug) DO NOTHING;
