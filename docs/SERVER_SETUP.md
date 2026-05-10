# Server setup (one-time)

The CD pipeline assumes a single Linux host with systemd, nginx, and Postgres
reachable from the API. SSH password auth is used for the deploy.

Replace `pgdp.example.com` with your hostname and `pgdp` with your unix user
throughout.

## 1. Create the deploy user and directory

```bash
sudo adduser --disabled-password --gecos "" pgdp
sudo mkdir -p /opt/pgdp/{releases,log}
sudo chown -R pgdp:pgdp /opt/pgdp
```

## 2. Allow the deploy user to restart the API service

```bash
sudo tee /etc/sudoers.d/pgdp >/dev/null <<'EOF'
pgdp ALL=(ALL) NOPASSWD: /bin/systemctl restart pgdp-api,            \
                         /bin/systemctl status  pgdp-api,            \
                         /usr/bin/journalctl -u pgdp-api*
EOF
sudo chmod 440 /etc/sudoers.d/pgdp
```

## 3. Set the SSH password for the deploy user

```bash
sudo passwd pgdp
```

That password goes into the GitHub `SSH_PASSWORD` secret.

> Prefer key-based auth long-term; password auth is what you asked for and
> works fine over a TLS-tunnelled SSH on a non-standard port.

## 4. systemd unit

```bash
sudo tee /etc/systemd/system/pgdp-api.service >/dev/null <<'EOF'
[Unit]
Description=PGDP API
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=pgdp
WorkingDirectory=/opt/pgdp/current
EnvironmentFile=/opt/pgdp/current/.env
ExecStart=/opt/pgdp/current/bin/pgdp-api
Restart=on-failure
RestartSec=3
LimitNOFILE=65536
StandardOutput=append:/opt/pgdp/log/api.log
StandardError=append:/opt/pgdp/log/api.err

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable pgdp-api
```

The service won't start cleanly until the first deploy lands and writes
`/opt/pgdp/current/.env`. That's fine.

## 5. nginx site

```bash
sudo tee /etc/nginx/sites-available/pgdp >/dev/null <<'EOF'
server {
  listen 80;
  server_name pgdp.example.com;

  # SPA — vite dist
  root /opt/pgdp/current/web;
  index index.html;

  location / {
    try_files $uri /index.html;
  }

  # API
  location /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /healthz { proxy_pass http://127.0.0.1:8080; }

  # Websockets
  location /api/v1/ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_read_timeout 1h;
  }
}
EOF
sudo ln -sf /etc/nginx/sites-available/pgdp /etc/nginx/sites-enabled/pgdp
sudo nginx -t && sudo systemctl reload nginx
```

Add TLS via `certbot --nginx` once DNS resolves.

## 6. Postgres + Redis

The pipeline does **not** install or migrate the database from a blank slate
beyond running `pgdp-migrate up`. You need a Postgres role + database:

```sql
CREATE USER pgdp WITH PASSWORD 'choose-a-strong-one';
CREATE DATABASE pgdp OWNER pgdp;
GRANT ALL PRIVILEGES ON DATABASE pgdp TO pgdp;
```

`DATABASE_URL` in your GitHub secrets should look like:

```
postgres://pgdp:<password>@127.0.0.1:5432/pgdp?sslmode=disable
```

(Use `sslmode=require` if your cluster terminates TLS.)

Redis: install and use defaults; the app expects `redis://127.0.0.1:6379/0`.

## 7. Trigger the first deploy

From a workstation, run:

```bash
gh workflow run cd.yml --ref main
```

Or merge a PR into `main`. Watch it via:

```bash
gh run watch
```

The first run will take ~3 minutes (Go build + npm install on a cold runner).

## 8. Smoke test

```bash
curl -s https://pgdp.example.com/healthz                    # {"ok":true}
curl -s -X POST https://pgdp.example.com/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"sadiq@theaccubin.com","password":"Admin@12345"}' | jq .
```

If `/healthz` is failing, ssh in and:

```bash
journalctl -u pgdp-api -n 100 --no-pager
ls -la /opt/pgdp/current
```
