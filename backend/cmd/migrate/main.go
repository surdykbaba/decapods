package main

import (
	"flag"
	"log/slog"
	"os"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"github.com/decapods/pgdp/backend/internal/platform/config"
)

func main() {
	dir := flag.String("dir", "backend/migrations", "migrations dir")
	cmd := flag.String("cmd", "up", "up|down|version")
	flag.Parse()

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}

	m, err := migrate.New("file://"+*dir, cfg.DatabaseURL)
	if err != nil {
		slog.Error("migrate new", "err", err)
		os.Exit(1)
	}
	defer m.Close()

	switch *cmd {
	case "up":
		err = m.Up()
	case "down":
		err = m.Steps(-1)
	case "version":
		v, dirty, e := m.Version()
		slog.Info("migration version", "version", v, "dirty", dirty, "err", e)
		return
	default:
		slog.Error("unknown cmd", "cmd", *cmd)
		os.Exit(2)
	}
	if err != nil && err != migrate.ErrNoChange {
		slog.Error("migrate", "err", err)
		os.Exit(1)
	}
	slog.Info("migration ok", "cmd", *cmd)
}
