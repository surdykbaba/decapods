# Project Governance & Delivery Portal (PGDP)

A production-grade enterprise platform for governance, delivery, finance, and workforce
analytics across government, private, international, and internal projects.

## Stack

- **Frontend** — Vite + React 18 + React Router + TypeScript + TailwindCSS + PWA (vite-plugin-pwa)
- **Backend** — Go 1.22 + Gin, clean/modular architecture
- **Database** — PostgreSQL 16 (with row-level-security ready schema)
- **Auth** — JWT (access + refresh) + RBAC + MFA-ready (TOTP)
- **Realtime** — WebSockets (gorilla/websocket) + SSE fallback
- **Storage** — S3-compatible (MinIO in dev)
- **Queue** — Redis + asynq workers
- **Infra** — Docker Compose (dev), Kubernetes-ready manifests (prod)
- **CI/CD** — GitHub Actions

## Quick start

```bash
# 1. Boot the stack
docker compose up -d postgres redis minio

# 2. Backend
cd backend
cp .env.example .env
go run ./cmd/api

# 3. Frontend
cd frontend
cp .env.example .env
pnpm install
pnpm dev
```

Open http://localhost:5173 — default seed user `sadiq@theaccubin.com / Admin@12345`.

## Repo layout

```
.
├── ARCHITECTURE.md         # Full system architecture (24 deliverables)
├── backend/                # Go API + workers
│   ├── cmd/                # Entrypoints (api, worker, migrate)
│   ├── internal/
│   │   ├── auth/           # JWT, RBAC, MFA
│   │   ├── governance/     # Policy engine, risk scoring
│   │   ├── projects/       # Pipeline, delivery
│   │   ├── workforce/      # Burnout analytics
│   │   ├── finance/        # Invoicing, P&L
│   │   ├── github/         # GitHub integration
│   │   ├── notify/         # Email/Slack/in-app
│   │   ├── audit/          # Immutable audit log
│   │   ├── storage/        # S3 adapter
│   │   ├── platform/       # config, logger, db, redis
│   │   └── http/           # router, middleware, handlers
│   ├── migrations/         # SQL migrations (golang-migrate)
│   └── openapi.yaml
├── frontend/               # Vite React app
│   ├── src/
│   │   ├── app/            # routing + providers
│   │   ├── modules/        # feature folders mirroring backend
│   │   ├── components/     # design system
│   │   ├── lib/            # api client, hooks
│   │   └── pwa/
│   └── public/
├── deploy/                 # docker, k8s, helm
└── .github/workflows/      # CI/CD
```

See `ARCHITECTURE.md` for the full design.
