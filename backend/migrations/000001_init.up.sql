-- PGDP initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- =========================================================
-- Tenancy & identity
-- =========================================================
CREATE TABLE tenants (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    slug        text NOT NULL UNIQUE,
    settings    jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id),
    email         citext NOT NULL UNIQUE,
    full_name     text NOT NULL,
    password_hash text NOT NULL,
    mfa_enabled   boolean NOT NULL DEFAULT false,
    status        text NOT NULL DEFAULT 'active',
    last_login_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz
);
CREATE INDEX users_tenant_idx ON users (tenant_id) WHERE deleted_at IS NULL;

CREATE TABLE roles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid REFERENCES tenants(id),  -- NULL = system role
    name        text NOT NULL,
    description text,
    UNIQUE (tenant_id, name)
);

CREATE TABLE user_roles (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE mfa_secrets (
    user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mfa_challenges (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);

CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fingerprint  text,
    ip_inet      inet,
    user_agent   text,
    issued_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz
);

-- =========================================================
-- Clients & opportunities (BD pipeline)
-- =========================================================
CREATE TABLE clients (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id),
    name       text NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('government','private','foreign','ngo','internal')),
    country    text,
    contact    jsonb NOT NULL DEFAULT '{}',
    metadata   jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE TABLE opportunities (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id),
    client_id          uuid NOT NULL REFERENCES clients(id),
    title              text NOT NULL,
    lead_type          text NOT NULL,
    source             text,
    category           text,
    estimated_value    numeric(14,2),
    budget             numeric(14,2),
    priority           smallint NOT NULL DEFAULT 3,
    risk_level         text,
    delivery_deadline  date,
    business_lead_id   uuid REFERENCES users(id),
    technical_scope    text,
    proposal_summary   text,
    expected_manpower  int,
    dependencies       text[],
    compliance_tags    text[],
    metadata           jsonb NOT NULL DEFAULT '{}',
    stage              text NOT NULL DEFAULT 'new_request',
    created_by         uuid REFERENCES users(id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz
);
CREATE INDEX opportunities_tenant_stage_idx ON opportunities (tenant_id, stage) WHERE deleted_at IS NULL;

CREATE TABLE opportunity_documents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
    kind            text NOT NULL,
    name            text NOT NULL,
    object_key      text NOT NULL,
    uploaded_by     uuid REFERENCES users(id),
    uploaded_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE opportunity_approvals (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id),
    opportunity_id  uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
    role_required   text NOT NULL,
    status          text NOT NULL DEFAULT 'pending',
    decided_by      uuid REFERENCES users(id),
    decided_at      timestamptz,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- =========================================================
-- Projects, milestones, tasks
-- =========================================================
CREATE TABLE projects (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id),
    opportunity_id  uuid REFERENCES opportunities(id),
    client_id       uuid NOT NULL REFERENCES clients(id),
    code            text NOT NULL,
    name            text NOT NULL,
    category        text,
    status          text NOT NULL DEFAULT 'planning',
    priority        smallint NOT NULL DEFAULT 3,
    risk_score      numeric(5,2) NOT NULL DEFAULT 0,
    health          text NOT NULL DEFAULT 'green',
    budget_amount   numeric(14,2),
    currency        char(3) NOT NULL DEFAULT 'USD',
    start_date      date,
    end_date        date,
    metadata        jsonb NOT NULL DEFAULT '{}',
    created_by      uuid REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,
    UNIQUE (tenant_id, code)
);
CREATE INDEX projects_tenant_status_idx ON projects (tenant_id, status) WHERE deleted_at IS NULL;

CREATE TABLE project_members (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id),
    role        text NOT NULL,
    allocation  numeric(4,3) NOT NULL DEFAULT 1.0 CHECK (allocation BETWEEN 0 AND 1),
    added_at    timestamptz NOT NULL DEFAULT now(),
    removed_at  timestamptz,
    UNIQUE (project_id, user_id, role)
);

CREATE TABLE milestones (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       text NOT NULL,
    due_on      date,
    status      text NOT NULL DEFAULT 'pending',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    milestone_id  uuid REFERENCES milestones(id),
    title         text NOT NULL,
    description   text,
    assignee_id   uuid REFERENCES users(id),
    status        text NOT NULL DEFAULT 'todo',
    priority      smallint NOT NULL DEFAULT 3,
    due_on        date,
    created_by    uuid REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz
);
CREATE INDEX tasks_project_status_idx ON tasks (project_id, status) WHERE deleted_at IS NULL;
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id) WHERE deleted_at IS NULL;

CREATE TABLE task_comments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author_id  uuid REFERENCES users(id),
    body       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_dependencies (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    description text NOT NULL,
    blocked     boolean NOT NULL DEFAULT false,
    blocked_at  timestamptz
);

CREATE TABLE project_health_snapshots (
    id          bigserial PRIMARY KEY,
    project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    score       numeric(5,2) NOT NULL,
    health      text NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================
-- Governance, policies, SLAs
-- =========================================================
CREATE TABLE policy_rules (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id),
    code        text NOT NULL,
    kind        text NOT NULL,
    active      boolean NOT NULL DEFAULT true,
    definition  jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, code)
);

CREATE TABLE governance_violations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id),
    entity      text NOT NULL,
    entity_id   uuid NOT NULL,
    code        text NOT NULL,
    message     text NOT NULL,
    resolved    boolean NOT NULL DEFAULT false,
    detected_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);

CREATE TABLE sla_definitions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id),
    code         text NOT NULL,
    description  text,
    max_hours    int NOT NULL,
    on_breach    text NOT NULL DEFAULT 'notify',
    UNIQUE (tenant_id, code)
);

CREATE TABLE sla_breaches (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id),
    sla_id      uuid REFERENCES sla_definitions(id),
    entity      text NOT NULL,
    entity_id   uuid NOT NULL,
    detected_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);

-- =========================================================
-- Workforce
-- =========================================================
CREATE TABLE time_entries (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id),
    project_id  uuid NOT NULL REFERENCES projects(id),
    task_id     uuid REFERENCES tasks(id),
    work_date   date NOT NULL,
    hours       numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
    notes       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX time_entries_user_date_idx ON time_entries (user_id, work_date);

CREATE TABLE burnout_signals (
    id           bigserial PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users(id),
    score        numeric(5,2) NOT NULL,
    band         text NOT NULL,
    captured_at  timestamptz NOT NULL DEFAULT now(),
    signals      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX burnout_user_captured_idx ON burnout_signals (user_id, captured_at DESC);

CREATE TABLE productivity_metrics (
    id              bigserial PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES users(id),
    captured_on     date NOT NULL,
    after_hours_pct numeric(4,3),
    commits         int,
    pr_opened       int,
    pr_reviewed     int,
    UNIQUE (user_id, captured_on)
);

-- =========================================================
-- Finance
-- =========================================================
CREATE TABLE contracts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id),
    project_id  uuid NOT NULL REFERENCES projects(id),
    number      text NOT NULL,
    value       numeric(14,2) NOT NULL,
    currency    char(3) NOT NULL DEFAULT 'USD',
    starts_on   date,
    ends_on     date,
    revrec      text NOT NULL DEFAULT 'on_invoice',
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, number)
);

CREATE TABLE invoices (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id),
    project_id    uuid NOT NULL REFERENCES projects(id),
    milestone_id  uuid REFERENCES milestones(id),
    number        text NOT NULL,
    amount        numeric(14,2) NOT NULL,
    currency      char(3) NOT NULL DEFAULT 'USD',
    status        text NOT NULL DEFAULT 'draft',
    issued_on     date,
    due_on        date,
    created_by    uuid REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz,
    UNIQUE (tenant_id, number)
);
CREATE INDEX invoices_tenant_status_idx ON invoices (tenant_id, status) WHERE deleted_at IS NULL;

CREATE TABLE invoice_lines (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description text NOT NULL,
    quantity    numeric(10,3) NOT NULL DEFAULT 1,
    unit_price  numeric(14,2) NOT NULL,
    amount      numeric(14,2) NOT NULL
);

CREATE TABLE payments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id),
    invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    amount      numeric(14,2) NOT NULL,
    paid_on     date NOT NULL,
    method      text,
    reference   text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE expenses (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id),
    project_id  uuid NOT NULL REFERENCES projects(id),
    vendor      text,
    description text,
    amount      numeric(14,2) NOT NULL,
    incurred_on date NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE budgets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id),
    project_id  uuid NOT NULL REFERENCES projects(id),
    category    text NOT NULL,
    amount      numeric(14,2) NOT NULL,
    UNIQUE (project_id, category)
);

-- =========================================================
-- GitHub integration
-- =========================================================
CREATE TABLE gh_repositories (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    owner           text NOT NULL,
    name            text NOT NULL,
    installation_id bigint,
    UNIQUE (owner, name)
);

CREATE TABLE gh_pull_requests (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id          uuid NOT NULL REFERENCES gh_repositories(id) ON DELETE CASCADE,
    number           int NOT NULL,
    title            text,
    state            text,
    author_login     text,
    reviewer_user_id uuid REFERENCES users(id),
    created_at       timestamptz,
    merged_at        timestamptz,
    reviewed_at      timestamptz,
    UNIQUE (repo_id, number)
);

CREATE TABLE gh_commits (
    sha              text PRIMARY KEY,
    repo_id          uuid NOT NULL REFERENCES gh_repositories(id) ON DELETE CASCADE,
    author_login     text,
    author_user_id   uuid REFERENCES users(id),
    message          text,
    committed_at     timestamptz
);

CREATE TABLE gh_deployments (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id      uuid NOT NULL REFERENCES gh_repositories(id) ON DELETE CASCADE,
    environment  text,
    status       text,
    deployed_at  timestamptz
);

CREATE TABLE gh_webhook_events (
    id          uuid PRIMARY KEY,
    delivery_id text NOT NULL UNIQUE,
    event       text NOT NULL,
    payload     jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================
-- Notifications & audit
-- =========================================================
CREATE TABLE notifications (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id),
    user_id     uuid NOT NULL REFERENCES users(id),
    kind        text NOT NULL,
    title       text NOT NULL,
    body        text,
    data        jsonb NOT NULL DEFAULT '{}',
    read_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE notification_preferences (
    user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channels   jsonb NOT NULL DEFAULT '{"email":true,"in_app":true,"slack":false,"push":true}',
    digest_at  text DEFAULT '08:00'
);

CREATE TABLE webhook_endpoints (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id),
    kind        text NOT NULL,
    url         text NOT NULL,
    secret      text,
    active      boolean NOT NULL DEFAULT true
);

CREATE TABLE audit_log (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id),
    actor_id    uuid REFERENCES users(id),
    action      text NOT NULL,
    entity      text NOT NULL,
    entity_id   uuid NOT NULL,
    diff        jsonb NOT NULL DEFAULT '{}',
    prev_hash   text,
    self_hash   text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id, created_at DESC);

-- Materialised view scaffold for executive KPIs (refreshed by worker).
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_executive_kpis AS
SELECT
    p.tenant_id,
    COUNT(*) FILTER (WHERE p.deleted_at IS NULL)                                  AS total_projects,
    COUNT(*) FILTER (WHERE p.health = 'red')                                      AS red_projects,
    COUNT(*) FILTER (WHERE p.end_date < current_date AND p.status NOT IN ('paid','closed')) AS delayed_projects,
    COALESCE(SUM(p.budget_amount),0)                                              AS total_budget
FROM projects p
GROUP BY p.tenant_id;
