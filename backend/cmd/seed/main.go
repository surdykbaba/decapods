// seed creates a default tenant + admin user with a freshly generated
// argon2id password hash, idempotently. Run after `migrate up`.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"github.com/decapods/pgdp/backend/internal/auth"
	"github.com/decapods/pgdp/backend/internal/platform/config"
	"github.com/decapods/pgdp/backend/internal/platform/db"
)

const (
	tenantID = "00000000-0000-0000-0000-000000000001"
	userID   = "22222222-0000-0000-0000-000000000001"
	roleID   = "11111111-0000-0000-0000-000000000001"
	email    = "admin@pgdp.local"
	password = "Admin@12345"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("db", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	hash, err := auth.HashPassword(password)
	if err != nil {
		slog.Error("hash", "err", err)
		os.Exit(1)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO tenants (id, name, slug)
		VALUES ($1, 'Acme Holdings', 'acme')
		ON CONFLICT (id) DO NOTHING`, tenantID)
	if err != nil {
		slog.Error("tenant", "err", err)
		os.Exit(1)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO roles (id, tenant_id, name, description)
		VALUES ($1, NULL, 'super_admin', 'Full access')
		ON CONFLICT (id) DO NOTHING`, roleID)
	if err != nil {
		slog.Error("role", "err", err)
		os.Exit(1)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO users (id, tenant_id, email, full_name, password_hash, mfa_enabled)
		VALUES ($1, $2, $3, 'Acme Admin', $4, false)
		ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
		userID, tenantID, email, hash)
	if err != nil {
		slog.Error("user", "err", err)
		os.Exit(1)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
		ON CONFLICT DO NOTHING`, userID, roleID)
	if err != nil {
		slog.Error("user_role", "err", err)
		os.Exit(1)
	}

	fmt.Printf("seed ok\n  email:    %s\n  password: %s\n", email, password)
}
