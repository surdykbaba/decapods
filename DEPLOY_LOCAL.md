# PGDP — local deployment (ServBay / macOS)

This guide deploys PGDP against your local ServBay Postgres.

## Prerequisites

- ServBay running with **Postgres** (creds: `sadiqarogundade` / `ServBay.dev`)
- ServBay **Redis** (or `brew install redis && brew services start redis`)
- Go 1.22+ (`brew install go`)
- Node 20+ (`brew install node`)
- (optional) MinIO / S3 for document storage — not required to boot

## 1. Clone the branch

```bash
git clone https://github.com/surdykbaba/decapods.git
cd decapods
git checkout main           # after the PR is merged
```

## 2. Create the database

In ServBay's Postgres GUI (or via psql):

```bash
psql -U sadiqarogundade -h localhost -d postgres \
  -c "CREATE DATABASE pgdp;"
```

## 3. Backend

```bash
cd backend
cp .env.example .env
# .env already points at postgres://sadiqarogundade:ServBay.dev@localhost:5432/pgdp

go mod download

# Run migrations
go run ./cmd/migrate -dir ./migrations -cmd up

# Seed an admin user with a real password hash
go run ./cmd/seed
# → prints: admin@pgdp.local / Admin@12345

# Start the API on :8080
go run ./cmd/api
```

In a second terminal, optionally start the worker:

```bash
cd backend
go run ./cmd/worker
```

## 4. Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev          # http://localhost:5173
```

Sign in with `admin@pgdp.local / Admin@12345`.

## 5. Production-style boot (one command)

If you have Docker Desktop:

```bash
docker compose up --build
# web → http://localhost
# api → http://localhost:8080
```

The compose file uses its own bundled Postgres — for local dev against ServBay
prefer the steps above.

## Troubleshooting

| Symptom                           | Fix                                                                 |
|-----------------------------------|---------------------------------------------------------------------|
| `connection refused` on :5432     | Start ServBay's Postgres service                                    |
| `password authentication failed`  | Check `pg_hba.conf`; ServBay default is `md5` — creds above are fine |
| `database "pgdp" does not exist`  | Run step 2                                                          |
| `redis: connection refused`       | Start Redis (`brew services start redis`)                           |
| Frontend can't reach API          | Vite dev proxy targets `http://localhost:8080` — make sure API is up |
