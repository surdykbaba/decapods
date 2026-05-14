package digest

import (
	"context"
	"log/slog"
	"time"
)

// StartScheduler runs an in-process ticker that fires SendDue every 30
// minutes between Monday 07:00–10:59 (server local time). The
// 6-day-since-last-sent guard in SendDue makes the tick idempotent —
// the first tick after a fresh Monday sends, subsequent ticks find
// nothing to do.
//
// We keep it in-process (no Cron, no separate worker) because:
//   - The API server is the only always-on Go process in prod.
//   - The work is bounded (one query per user × ~tens of users).
//   - The asynq worker is a stub today; no point adding a dependency
//     until we outgrow the simple ticker.
//
// Returns immediately; the goroutine exits when ctx is cancelled.
func StartScheduler(ctx context.Context, s *Sender, log *slog.Logger) {
	go func() {
		// Align the first tick to a clean minute so logs are tidy.
		t := time.NewTicker(30 * time.Minute)
		defer t.Stop()
		// Fire once on boot in case the server restarted Monday morning.
		runOnce(ctx, s, log, time.Now())
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				runOnce(ctx, s, log, now)
			}
		}
	}()
}

func runOnce(ctx context.Context, s *Sender, log *slog.Logger, now time.Time) {
	if !isSendWindow(now) {
		return
	}
	sent, skipped, err := s.SendDue(ctx, now)
	if err != nil {
		log.Error("weekly digest sweep failed", "err", err)
		return
	}
	if sent > 0 || skipped > 0 {
		log.Info("weekly digest sweep", "sent", sent, "skipped", skipped, "at", now.Format(time.RFC3339))
	}
}

// isSendWindow — Monday 07:00 – 10:59. Generous so a slow boot still
// catches the window; the 6-day idempotence guard handles dupes.
func isSendWindow(t time.Time) bool {
	if t.Weekday() != time.Monday {
		return false
	}
	h := t.Hour()
	return h >= 7 && h < 11
}
