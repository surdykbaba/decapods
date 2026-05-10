# PGDP — System Architecture

This document is the canonical architectural reference for the **Project Governance &
Delivery Portal**. It covers the 24 deliverables called out in the product brief.

---

## 1. System Architecture

### 1.1 Logical view

```
┌─────────────────────────────────────────────────────────────────────┐
│                              Clients                                │
│   Web (PWA)        Desktop (PWA installed)        Mobile (PWA)      │
└──────────────┬──────────────────────────┬───────────────────────────┘
               │ HTTPS / WSS              │
┌──────────────▼──────────────────────────▼───────────────────────────┐
│                       Edge (NGINX / ALB / CloudFront)               │
│           TLS, WAF, rate limiting, gzip/brotli, HTTP/2              │
└──────────────┬──────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────────┐
│                       PGDP API (Go / Gin)                           │
│  ┌──────────┬──────────┬───────────┬──────────┬──────────────────┐  │
│  │  auth    │ projects │ governance│ workforce│  finance         │  │
│  ├──────────┼──────────┼───────────┼──────────┼──────────────────┤  │
│  │ github   │ notify   │  audit    │ storage  │ analytics        │  │
│  └──────────┴──────────┴───────────┴──────────┴──────────────────┘  │
│   HTTP REST  •  WebSocket hub  •  SSE  •  OpenAPI 3                 │
└──────┬───────────────┬──────────────────┬───────────────────────────┘
       │               │                  │
   ┌───▼────┐     ┌────▼────┐       ┌─────▼─────┐
   │Postgres│     │  Redis  │       │   MinIO   │
   │  16    │     │ pubsub+ │       │   (S3)    │
   │        │     │  asynq  │       │           │
   └────────┘     └────┬────┘       └───────────┘
                       │
                ┌──────▼──────┐
                │   Workers   │
                │  (Go asynq) │
                │  notify •   │
                │  github •   │
                │  risk •     │
                │  burnout    │
                └─────────────┘
```

### 1.2 Architectural style

- **Modular monolith** that ships as one binary (`api`) plus a `worker` binary, sharing
  `internal/` packages. Each `internal/<module>` is self-contained (handlers, service,
  repository, events) so it can be peeled into a microservice when scale demands it.
- **Clean architecture** layering: `handler → service → repository → db`. Domain types
  live in `internal/<module>/domain.go`; transport types in `internal/http/dto`.
- **Event-driven** via Redis Streams + asynq. Every state transition publishes a domain
  event (e.g. `project.stage_changed`) consumed by notify, audit, analytics.
- **CQRS-ready** — read models for dashboards live in materialised views refreshed by
  the worker (`mv_executive_kpis`, `mv_workforce_load`).

---

## 2. Database Schema (high level)

See `backend/migrations/` for the executable DDL. Core groups:

- **Identity** — `users`, `roles`, `user_roles`, `permissions`, `sessions`,
  `mfa_secrets`, `api_keys`, `audit_log`.
- **Tenancy** — `tenants`, `tenant_members`. Every domain table carries `tenant_id`,
  enforced via Postgres RLS policies.
- **Pipeline** — `clients`, `opportunities`, `pipeline_stages`,
  `opportunity_documents`, `opportunity_approvals`, `opportunity_events`.
- **Projects** — `projects`, `milestones`, `tasks`, `task_comments`,
  `project_members`, `project_dependencies`, `project_health_snapshots`.
- **Governance** — `policies`, `policy_rules`, `required_documents`,
  `approval_chains`, `risk_scores`, `sla_definitions`, `sla_breaches`.
- **Workforce** — `time_entries`, `workload_snapshots`, `burnout_signals`,
  `availability`, `productivity_metrics`.
- **Finance** — `contracts`, `invoices`, `invoice_lines`, `payments`,
  `expenses`, `vendors`, `budgets`, `revenue_recognition`.
- **GitHub** — `gh_repositories`, `gh_pull_requests`, `gh_commits`,
  `gh_deployments`, `gh_releases`.
- **Notifications** — `notifications`, `notification_channels`,
  `notification_preferences`, `webhook_endpoints`.

All tables: `id uuid pk`, `tenant_id uuid`, `created_at`, `updated_at`,
`deleted_at` (soft delete), `created_by`, `updated_by`. Hot lookup columns indexed;
JSONB used for `metadata` blobs.

---

## 3. Folder Structure

See `README.md`. Backend follows the `internal/<bounded-context>` pattern; frontend
mirrors backend with `src/modules/<bounded-context>` so cognitive load stays low.

---

## 4. Backend API Design

- REST under `/api/v1/...`, JSON only, snake_case field names, ISO-8601 timestamps,
  `Idempotency-Key` honoured on POST/PUT.
- Pagination via cursor (`?cursor=<opaque>&limit=50`).
- Filtering via RHS-bracket syntax (`?status[in]=in_progress,qa_review`).
- Errors follow RFC 7807 problem-details.
- WebSocket: `/ws` (auth via `Sec-WebSocket-Protocol: bearer,<jwt>`).
  Topics: `tenant:<id>:notifications`, `project:<id>:activity`.
- OpenAPI 3.1 published at `/openapi.yaml`; Swagger UI at `/docs`.

Representative endpoints:

```
POST   /api/v1/auth/login
POST   /api/v1/auth/mfa/verify
POST   /api/v1/auth/refresh
GET    /api/v1/me

POST   /api/v1/opportunities                  (wizard step 1..N)
POST   /api/v1/opportunities/{id}/documents
POST   /api/v1/opportunities/{id}/submit       (governance gate)
POST   /api/v1/opportunities/{id}/transition   {to: "approved"}

GET    /api/v1/projects?status[in]=in_progress
POST   /api/v1/projects/{id}/milestones
POST   /api/v1/projects/{id}/tasks
POST   /api/v1/projects/{id}/risk/recalculate

GET    /api/v1/workforce/load
GET    /api/v1/workforce/burnout
POST   /api/v1/workforce/time-entries

GET    /api/v1/finance/invoices
POST   /api/v1/finance/invoices
POST   /api/v1/finance/payments

GET    /api/v1/analytics/executive
GET    /api/v1/analytics/portfolio-health

POST   /api/v1/integrations/github/link
POST   /api/v1/integrations/github/webhook    (signed)

GET    /api/v1/governance/policies
POST   /api/v1/governance/policies
GET    /api/v1/audit?entity=project&id=...
```

---

## 5. Frontend Routing

```
/                                → redirect to /dashboard or /login
/login                           public
/mfa                             public (post-password)
/dashboard                       executive overview
/pipeline                        BD board
/pipeline/new                    wizard
/pipeline/:id                    opportunity detail
/projects                        list + filters
/projects/:id                    project shell
/projects/:id/board              kanban
/projects/:id/timeline           gantt
/projects/:id/team               members + capacity
/projects/:id/docs               documents
/projects/:id/risk               risk + governance
/projects/:id/finance            P&L
/workforce                       utilization heatmap
/workforce/burnout               burnout dashboard
/finance                         finance home
/finance/invoices
/finance/receivables
/governance/policies
/governance/audit
/integrations/github
/admin/users
/admin/roles
/admin/settings
/profile
```

Route guards: `<RequireAuth roles={["finance","admin"]}>`. Code-split per module.

---

## 6. RBAC Model

- **Subjects**: users, service accounts.
- **Roles** (system): `super_admin`, `ceo`, `coo`, `finance`, `hr`,
  `business_dev`, `delivery_manager`, `project_manager`, `engineer`, `qa`,
  `auditor`, `compliance_officer`, `client_viewer`.
- **Permissions** are tuples `(action, resource, scope)`, e.g.
  `("approve", "opportunity", "tenant")` or `("read", "project", "self")`.
- **Policy evaluation**: Casbin-compatible rule strings persisted in `policies`,
  loaded at boot, hot-reloaded on change.
- **Project-level overrides**: `project_members.role` grants scoped permissions
  on a single project (e.g. external client_viewer).
- **Service-side guard**: `auth.RequirePermission("project:write")` middleware.
- **DB-side guard**: Postgres RLS policies keyed off `current_setting('app.user_id')`
  set per-connection from the request context.

---

## 7. Workflow Engine

- Generic state machine in `internal/governance/workflow`.
- A **workflow definition** is JSON: states, transitions, guards, hooks.
- Built-in workflows: `OpportunityLifecycle`, `ProjectLifecycle`, `InvoiceLifecycle`,
  `ApprovalChain`.
- Each transition runs:
  1. **Guards** (policy engine) — required docs present, approver role satisfied,
     SLA not breached.
  2. **Side effects** — emit domain event, append audit row, schedule reminders.
- Approval chains support sequential, parallel, and quorum (`m of n`) gates.

---

## 8. Governance Policy Engine

- Rules expressed as JSON-Logic, persisted in `policy_rules`.
- Rule kinds:
  - `required_document` — `{when: {project_type: "government"}, require: ["NDA","RFP"]}`
  - `approval_required` — `{when: {value_gt: 100000}, approvers: ["CEO","Finance"]}`
  - `risk_threshold` — `{score_gt: 70, action: "block_progress"}`
  - `sla` — `{stage: "under_review", max_hours: 72, on_breach: "escalate"}`
- Engine entrypoint: `governance.Evaluate(ctx, subject, rules) → Decision{allow, violations[]}`.
- Violations are persisted; UI surfaces them on the entity.

---

## 9. Burnout Analytics Logic

Per engineer per day we collect:

| Signal               | Source                          | Weight |
|----------------------|---------------------------------|--------|
| `hours_logged`       | `time_entries`                  | 0.20   |
| `concurrent_projects`| `project_members` active        | 0.15   |
| `missed_deadlines_7d`| `tasks` overdue                 | 0.15   |
| `after_hours_pct`    | commits/PRs outside 08-19 local | 0.15   |
| `weekend_activity`   | git events Sat/Sun              | 0.10   |
| `pr_review_lag`      | GitHub                          | 0.10   |
| `ticket_throughput_z`| z-score vs 30-day baseline      | 0.15   |

Score = Σ(weight × normalised_signal). Bands:
`0-39 healthy`, `40-59 watch`, `60-79 elevated`, `80-100 critical`.

Worker `burnout-recompute` runs hourly, writes to `burnout_signals` and emits
`workforce.burnout.elevated` for the notifier.

---

## 10. GitHub Integration Flow

1. Admin creates GitHub App, installs on the org.
2. PGDP stores installation_id per tenant in `gh_installations`.
3. Webhooks (`/api/v1/integrations/github/webhook`) verify HMAC, enqueue
   `gh.event.process` job.
4. Worker normalises events → `gh_pull_requests`, `gh_commits`, `gh_deployments`.
5. Repos are linked to projects via `project_id` FK on `gh_repositories`.
6. Aggregations populate engineering KPIs and burnout signals.
7. Outbound: PGDP can comment on PRs when a governance gate fails.

---

## 11. Notification Architecture

```
domain event → notify.dispatcher → channel adapter → user
                       │
                       └─ persists `notifications` row (in-app)
```

Channels: `email` (SMTP/SES), `slack` (incoming webhook & bot), `teams`,
`webhook`, `in_app`, `push` (Web Push for PWA). Per-user preferences in
`notification_preferences`. Templates rendered with Go `text/template` and
localised via `golang.org/x/text/message`.

Realtime in-app uses the WebSocket hub broadcasting on `tenant:<id>:user:<id>`.

---

## 12. Finance Reporting

- **Invoices** linked to `projects.milestones`. Status machine:
  `draft → issued → partially_paid → paid → void`.
- **Revenue recognition**: configurable per contract — `on_invoice`, `on_payment`,
  `percent_complete` (POC), `milestone`.
- **Cost ledger** aggregates time-entry cost (rate × hours), vendor expenses, fixed
  costs. P&L = recognised revenue − cost ledger.
- **Receivables aging buckets**: 0-30, 31-60, 61-90, 90+.
- **Forecasts** computed nightly: weighted pipeline (probability × value) +
  contracted backlog.
- Reports exportable to CSV/XLSX; scheduled email digests via worker.

---

## 13. Executive Dashboard

Sections:

1. **Portfolio health** — donut by stage, delayed projects %, on-track %.
2. **Revenue** — MTD/QTD/YTD invoiced, paid, overdue. Forecast vs target.
3. **Risk exposure** — heatmap (probability × impact), top 10 risks.
4. **Workforce** — utilization gauge, burnout watchlist, hiring gap.
5. **Governance** — open violations, pending approvals, SLA breaches.
6. **Engineering** — velocity, deploy frequency, change failure rate, PR lead time
   (DORA).
7. **Bottlenecks** — stages with the longest median dwell time.

Driven by materialised views; refreshed every 5 min by worker. Each card supports
drill-down to the underlying list.

---

## 14. UI/UX Wireframe Descriptions

- **Shell**: collapsible left nav (icons + labels), top bar with global search
  (⌘K command palette), tenant switcher, notifications bell, profile menu.
  Dark mode is default; light theme follows `prefers-color-scheme`.
- **Executive dashboard**: 12-column grid, KPI tiles top row (height 96px), then
  two-column charts (revenue trend left, risk heatmap right), then 3-column
  tables.
- **Pipeline board**: Kanban columns per stage, draggable cards showing client,
  value, owner, days-in-stage chip; right-side drawer for detail.
- **Wizard**: 5-step stepper on the left, content centered max-w-3xl, sticky
  footer with Back/Save-draft/Continue. Each step shows live policy-engine
  feedback.
- **Project shell**: tab bar (Overview, Board, Timeline, Team, Docs, Risk,
  Finance), header with breadcrumb, status pill, health meter.
- **Workforce heatmap**: rows = people, columns = weeks, cell colour = utilization
  %; hover for breakdown. Filters at top (team, role, project).
- **Governance audit**: virtualised log table; filter by actor/entity/action;
  diff viewer for record changes.
- **Empty states**, **skeleton loaders**, and **error boundaries** are first-class.

Design tokens: spacing 4px base, rounded-xl, subtle borders (`border-border`),
elevation only via shadow on overlays. Components built on Radix Primitives +
Tailwind, see `frontend/src/components`.

---

## 15. Recommended Open-Source Libraries

**Backend (Go)**

| Concern        | Library                                    |
|----------------|--------------------------------------------|
| HTTP framework | `github.com/gin-gonic/gin`                 |
| Validation     | `github.com/go-playground/validator/v10`   |
| DB driver      | `github.com/jackc/pgx/v5`                  |
| Query builder  | `github.com/Masterminds/squirrel`          |
| Migrations     | `github.com/golang-migrate/migrate/v4`     |
| Auth (JWT)     | `github.com/golang-jwt/jwt/v5`             |
| MFA            | `github.com/pquerna/otp`                   |
| RBAC           | `github.com/casbin/casbin/v2`              |
| Workers        | `github.com/hibiken/asynq`                 |
| Logging        | `log/slog` (stdlib) + `samber/slog-multi`  |
| Config         | `github.com/spf13/viper`                   |
| Testing        | `github.com/stretchr/testify`              |
| OpenAPI gen    | `github.com/swaggo/swag`                   |
| WebSockets     | `github.com/gorilla/websocket`             |
| S3             | `github.com/aws/aws-sdk-go-v2`             |
| Email          | `github.com/wneessen/go-mail`              |
| GitHub         | `github.com/google/go-github/v66`          |

**Frontend**

| Concern       | Library                                   |
|---------------|-------------------------------------------|
| Routing       | `react-router-dom`                        |
| Server state  | `@tanstack/react-query`                   |
| Forms         | `react-hook-form` + `zod`                 |
| UI primitives | `@radix-ui/react-*`                       |
| Charts        | `recharts` (simple) + `visx` (complex)    |
| Tables        | `@tanstack/react-table`                   |
| Icons         | `lucide-react`                            |
| Drag & drop   | `@dnd-kit/core`                           |
| Dates         | `date-fns`                                |
| PWA           | `vite-plugin-pwa` (Workbox)               |
| Testing       | `vitest` + `@testing-library/react`       |
| E2E           | `playwright`                              |

---

## 16. Deployment Architecture

- **Dev** — `docker compose up`. Services: `postgres`, `redis`, `minio`,
  `mailhog`, `api`, `worker`, `web`.
- **Prod (cloud)** — Kubernetes:
  - `api` Deployment (3 replicas, HPA on CPU/RPS)
  - `worker` Deployment (asynq, scale on queue depth)
  - `web` Deployment (NGINX serving the built SPA + service worker)
  - `postgres` managed (RDS / Cloud SQL) with PITR
  - `redis` managed (ElastiCache / MemoryStore)
  - `s3` (or GCS) for documents
  - Ingress: NGINX or cloud LB; TLS via cert-manager + Let's Encrypt.
- **On-prem** — same Compose file or Helm chart in `deploy/helm/pgdp`.

Secrets via Kubernetes Secrets or external secret manager (Vault / AWS SM).

---

## 17. Docker Setup

See `docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile`. Multi-stage
images; non-root runtime; `HEALTHCHECK` defined for each service.

---

## 18. CI/CD Pipeline

See `.github/workflows/ci.yml` and `cd.yml`.

- **CI** on every PR: lint (golangci-lint, eslint), typecheck, unit tests
  (Go + Vitest), DB migration smoke, OpenAPI lint, container build,
  Trivy scan.
- **CD** on `main`: build & push images to GHCR with SHA + semver tag, deploy
  to staging via `kubectl set image`, run Playwright smoke; manual approval
  gates production rollout (canary 10% → 100%).

---

## 19. Security Architecture

- **AuthN**: password (argon2id) + TOTP MFA; refresh tokens rotated; session
  fingerprint binds (UA, IP/24).
- **AuthZ**: Casbin policy + RLS in Postgres for defence in depth.
- **Transport**: TLS 1.3, HSTS, secure cookies, CSRF tokens for cookie-based
  flows, CORS allow-list per tenant.
- **Headers**: CSP (strict), `Referrer-Policy`, `X-Content-Type-Options`,
  `Permissions-Policy`.
- **Audit**: append-only `audit_log` (hash-chained, tamper-evident); every
  mutating handler writes a row.
- **Secrets**: never in env at rest; loaded from secret manager.
- **Data**: at-rest encryption via cloud KMS; column-level encryption for PII
  (`pgcrypto`).
- **Rate limiting**: token bucket per IP + per user; abuse signals fed to WAF.
- **Vulnerability mgmt**: Dependabot, Trivy, gosec, semgrep in CI.
- **Compliance hooks**: ISO 27001, SOC 2 control mappings documented in
  `docs/compliance/`.

---

## 20. Multi-Tenant Readiness

- **Tenancy model**: shared schema with `tenant_id` + Postgres RLS; option to
  promote a tenant to its own schema or DB for sovereign deployments
  (government).
- Every connection sets `SET LOCAL app.tenant_id = $1` from JWT claim.
- S3 keys are prefixed `tenants/<id>/...`; signed URLs scoped per tenant.
- Background jobs carry `tenant_id` in payload; workers re-establish RLS
  context.
- Per-tenant configuration (branding, policies, integrations) in
  `tenant_settings`.

---

## 21. Example PostgreSQL Tables

See `backend/migrations/000001_init.up.sql` for the full DDL. Excerpt:

```sql
CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  opportunity_id  uuid REFERENCES opportunities(id),
  code            text NOT NULL,
  name            text NOT NULL,
  client_id       uuid NOT NULL REFERENCES clients(id),
  category        text NOT NULL,
  status          text NOT NULL DEFAULT 'planning',
  priority        smallint NOT NULL DEFAULT 3,
  risk_score      numeric(5,2) NOT NULL DEFAULT 0,
  health          text NOT NULL DEFAULT 'green',
  budget_amount   numeric(14,2),
  currency        char(3) NOT NULL DEFAULT 'USD',
  start_date      date,
  end_date        date,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (tenant_id, code)
);

CREATE INDEX projects_tenant_status_idx ON projects (tenant_id, status)
  WHERE deleted_at IS NULL;

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_rls ON projects USING (
  tenant_id = current_setting('app.tenant_id')::uuid
);
```

---

## 22. Example Go Services

See `backend/internal/projects/service.go`, `internal/governance/engine.go`,
`internal/workforce/burnout.go`. A representative slice:

```go
func (s *Service) Transition(ctx context.Context, id uuid.UUID, to Stage) error {
    p, err := s.repo.Get(ctx, id)
    if err != nil { return err }

    decision := s.gov.Evaluate(ctx, governance.Subject{
        Kind: "opportunity", ID: p.ID, Attrs: p.AsAttrs(),
    }, governance.ForTransition(p.Stage, to))
    if !decision.Allow {
        return governance.ErrBlocked(decision.Violations)
    }
    if err := s.repo.UpdateStage(ctx, id, to); err != nil { return err }

    s.events.Publish(ctx, "opportunity.stage_changed", map[string]any{
        "id": id, "from": p.Stage, "to": to,
    })
    return nil
}
```

---

## 23. Example React Pages

See `frontend/src/modules/`. The pipeline wizard, executive dashboard, and
project board are scaffolded end-to-end (page → query → API).

---

## 24. Microservice Evolution Roadmap

1. **Phase 0 (now)** — modular monolith + worker.
2. **Phase 1** — extract `notify` (high fan-out, independent SLOs).
3. **Phase 2** — extract `analytics` (heavy reads, separate read DB).
4. **Phase 3** — extract `github` ingestion (spiky traffic).
5. **Phase 4** — split `finance` (PCI-adjacent, stricter compliance boundary).
6. **Phase 5** — multi-region read replicas + per-region write shards keyed by
   `tenant_id` for data sovereignty.

Communication evolves: in-process events → Redis Streams → NATS / Kafka. Each
extraction is mechanical because modules already expose interfaces and emit
events.
