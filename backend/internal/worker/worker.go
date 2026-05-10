// Package worker hosts background jobs: notifications, GitHub event
// processing, risk recompute, burnout recompute, scheduled reports.
package worker

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/decapods/pgdp/backend/internal/platform/config"
	"github.com/hibiken/asynq"
	"github.com/redis/go-redis/v9"
)

const (
	TaskNotifyEmail        = "notify:email"
	TaskGitHubEvent        = "gh:event"
	TaskRecalcRisk         = "risk:recalc"
	TaskBurnoutRecompute   = "burnout:recompute"
	TaskNotifyDigest       = "notify:digest"
)

func Run(cfg *config.Config, log *slog.Logger) error {
	opt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return err
	}
	srv := asynq.NewServer(
		asynq.RedisClientOpt{Addr: opt.Addr, DB: opt.DB, Password: opt.Password},
		asynq.Config{Concurrency: 10, Queues: map[string]int{
			"critical": 6, "default": 3, "low": 1,
		}},
	)
	mux := asynq.NewServeMux()
	mux.HandleFunc(TaskNotifyEmail, handleNotifyEmail(log))
	mux.HandleFunc(TaskGitHubEvent, handleGitHubEvent(log))
	mux.HandleFunc(TaskRecalcRisk, handleRecalcRisk(log))
	mux.HandleFunc(TaskBurnoutRecompute, handleBurnoutRecompute(log))
	mux.HandleFunc(TaskNotifyDigest, handleDigest(log))

	log.Info("worker starting")
	return srv.Run(mux)
}

func handleNotifyEmail(log *slog.Logger) asynq.HandlerFunc {
	return func(ctx context.Context, t *asynq.Task) error {
		var p map[string]any
		_ = json.Unmarshal(t.Payload(), &p)
		log.Info("notify.email", "to", p["to"], "subject", p["subject"])
		// TODO integrate go-mail / SES; this scaffold logs only.
		return nil
	}
}

func handleGitHubEvent(log *slog.Logger) asynq.HandlerFunc {
	return func(ctx context.Context, t *asynq.Task) error {
		log.Info("gh.event", "bytes", len(t.Payload()))
		return nil
	}
}

func handleRecalcRisk(log *slog.Logger) asynq.HandlerFunc {
	return func(ctx context.Context, t *asynq.Task) error {
		log.Info("risk.recalc")
		return nil
	}
}

func handleBurnoutRecompute(log *slog.Logger) asynq.HandlerFunc {
	return func(ctx context.Context, t *asynq.Task) error {
		log.Info("burnout.recompute")
		return nil
	}
}

func handleDigest(log *slog.Logger) asynq.HandlerFunc {
	return func(ctx context.Context, t *asynq.Task) error {
		log.Info("notify.digest")
		return nil
	}
}
