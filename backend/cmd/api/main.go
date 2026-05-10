package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/decapods/pgdp/backend/internal/http/router"
	"github.com/decapods/pgdp/backend/internal/platform/config"
	"github.com/decapods/pgdp/backend/internal/platform/db"
	"github.com/decapods/pgdp/backend/internal/platform/logger"
	"github.com/decapods/pgdp/backend/internal/platform/redisx"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load", "err", err)
		os.Exit(1)
	}
	log := logger.New(cfg.LogLevel, cfg.Env)
	slog.SetDefault(log)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("db connect", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	rdb, err := redisx.Connect(ctx, cfg.RedisURL)
	if err != nil {
		log.Error("redis connect", "err", err)
		os.Exit(1)
	}
	defer rdb.Close()

	r := router.New(router.Deps{
		Cfg:   cfg,
		Log:   log,
		DB:    pool,
		Redis: rdb,
	})

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Info("api listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http serve", "err", err)
			cancel()
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, sc := context.WithTimeout(context.Background(), 15*time.Second)
	defer sc()
	_ = srv.Shutdown(shutdownCtx)
}
