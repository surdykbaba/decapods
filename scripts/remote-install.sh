#!/usr/bin/env bash
# remote-install.sh — runs on the server, called from .github/workflows/cd.yml.
#
# Layout it produces under $DEPLOY_PATH (default /opt/pgdp):
#
#   $DEPLOY_PATH/
#     current  -> releases/<sha>           (atomic symlink)
#     releases/
#       <sha>/
#         bin/{pgdp-api,pgdp-migrate,pgdp-worker}
#         migrations/
#         web/                              (vite dist; nginx serves this)
#         scripts/remote-install.sh
#         .env                              (rendered from CD env vars)
#     log/
#
# Steps:
#   1. Render .env from passed env vars.
#   2. (Optional) Run migrations.
#   3. Atomically swap `current` symlink to the new release.
#   4. Restart the systemd service.
#   5. Health-check the api on $APP_PORT.
#   6. Trim old releases (keep last 5).

set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:?DEPLOY_PATH is required}"
SERVICE_NAME="${SERVICE_NAME:-pgdp-api}"
APP_PORT="${APP_PORT:-8080}"
SHA="${SHA:?SHA is required}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-true}"

REL="$DEPLOY_PATH/releases/$SHA"
[ -d "$REL" ] || { echo "release dir not found: $REL"; exit 1; }

cd "$REL"

# ---- 1. Render .env (mode 600) ----
umask 077
cat >"$REL/.env" <<EOF
APP_ENV=production
APP_PORT=${APP_PORT}
APP_LOG_LEVEL=info

DATABASE_URL=${DATABASE_URL}
REDIS_URL=${REDIS_URL}

JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=720h

MASTER_KEY=${MASTER_KEY}
BLIND_INDEX_SALT=${BLIND_INDEX_SALT:-}

SMTP_HOST=${MAILGUN_SMTP_HOST}
SMTP_PORT=${MAILGUN_SMTP_PORT}
SMTP_USER=${MAILGUN_SMTP_USER:-}
SMTP_PASS=${MAILGUN_SMTP_PASS:-}
SMTP_FROM=${MAILGUN_FROM:-}

ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-*}
EOF
umask 022

# ---- 2. Migrations ----
if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "==> Running migrations"
  set -a; . "$REL/.env"; set +a
  "$REL/bin/pgdp-migrate" -dir "$REL/migrations" -cmd up
  if [ -x "$REL/bin/pgdp-seed" ]; then
    echo "==> Seeding (idempotent — refreshes admin password hash)"
    "$REL/bin/pgdp-seed" || echo "(seed skipped/failed; continuing)"
  fi
fi

# ---- 3. Symlink swap ----
echo "==> Swapping symlink to $SHA"
# If `current` is a real directory from initial provisioning, blow it away so we
# can replace it with a symlink. Subsequent deploys hit the symlink-to-symlink
# fast path via mv -T.
if [ -d "$DEPLOY_PATH/current" ] && [ ! -L "$DEPLOY_PATH/current" ]; then
  rm -rf "$DEPLOY_PATH/current"
fi
ln -sfn "$REL" "$DEPLOY_PATH/current.new"
mv -Tf  "$DEPLOY_PATH/current.new" "$DEPLOY_PATH/current"

# ---- 4. Restart the service ----
echo "==> Restarting $SERVICE_NAME"
sudo -n systemctl restart "$SERVICE_NAME"
sudo -n systemctl status  "$SERVICE_NAME" --no-pager | head -n 6 || true

# ---- 5. Health check ----
echo "==> Waiting for /healthz on :${APP_PORT}"
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/healthz" >/dev/null; then
    echo "==> Healthy after ${i}s"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "!! healthz never came up — investigate $SERVICE_NAME logs"
    sudo -n journalctl -u "$SERVICE_NAME" -n 80 --no-pager || true
    exit 1
  fi
  sleep 1
done

# ---- 6. Prune old releases (keep last 5) ----
cd "$DEPLOY_PATH/releases"
ls -1t | tail -n +6 | xargs -r rm -rf
echo "==> Done"
