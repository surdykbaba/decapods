package main

import (
	"log/slog"
	"os"

	"github.com/decapods/pgdp/backend/internal/platform/config"
	"github.com/decapods/pgdp/backend/internal/platform/logger"
	"github.com/decapods/pgdp/backend/internal/worker"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}
	log := logger.New(cfg.LogLevel, cfg.Env)
	slog.SetDefault(log)

	if err := worker.Run(cfg, log); err != nil {
		log.Error("worker exited", "err", err)
		os.Exit(1)
	}
}
