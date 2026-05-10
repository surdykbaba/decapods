// Package workforce computes utilization, burnout signals, and capacity
// forecasts.
package workforce

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct{ db *pgxpool.Pool }

func New(db *pgxpool.Pool) *Service { return &Service{db: db} }

type TimeEntryInput struct {
	UserID    uuid.UUID `json:"-"`
	ProjectID uuid.UUID `json:"project_id" binding:"required"`
	TaskID    uuid.UUID `json:"task_id"`
	Date      string    `json:"date" binding:"required"`
	Hours     float64   `json:"hours" binding:"required,gt=0,lte=24"`
	Notes     string    `json:"notes"`
}

func (s *Service) LogTime(ctx context.Context, in TimeEntryInput) (uuid.UUID, error) {
	id := uuid.New()
	_, err := s.db.Exec(ctx, `
		INSERT INTO time_entries (id, user_id, project_id, task_id, work_date, hours, notes)
		VALUES ($1,$2,$3, NULLIF($4,'00000000-0000-0000-0000-000000000000')::uuid, $5::date, $6, $7)`,
		id, in.UserID, in.ProjectID, in.TaskID, in.Date, in.Hours, in.Notes)
	return id, err
}

// LoadHeatmap returns utilization per user per week for the last 8 weeks.
func (s *Service) LoadHeatmap(ctx context.Context, tenantID uuid.UUID) (map[string]any, error) {
	rows, err := s.db.Query(ctx, `
		SELECT u.id, u.full_name,
		       date_trunc('week', te.work_date)::date AS wk,
		       SUM(te.hours) AS hours
		FROM users u
		LEFT JOIN time_entries te ON te.user_id = u.id
		      AND te.work_date >= current_date - interval '56 days'
		WHERE u.tenant_id = $1 AND u.deleted_at IS NULL
		GROUP BY u.id, u.full_name, wk
		ORDER BY u.full_name, wk`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type cell struct {
		Week  time.Time `json:"week"`
		Hours float64   `json:"hours"`
		Util  float64   `json:"utilization"`
	}
	people := map[uuid.UUID]map[string]any{}
	for rows.Next() {
		var (
			uid   uuid.UUID
			name  string
			wk    *time.Time
			hours *float64
		)
		if err := rows.Scan(&uid, &name, &wk, &hours); err != nil {
			continue
		}
		if _, ok := people[uid]; !ok {
			people[uid] = map[string]any{"id": uid, "name": name, "weeks": []cell{}}
		}
		if wk != nil {
			h := 0.0
			if hours != nil {
				h = *hours
			}
			people[uid]["weeks"] = append(people[uid]["weeks"].([]cell), cell{
				Week: *wk, Hours: h, Util: h / 40.0,
			})
		}
	}
	out := []map[string]any{}
	for _, p := range people {
		out = append(out, p)
	}
	return map[string]any{"people": out}, nil
}

// BurnoutWatchlist computes the burnout score described in ARCHITECTURE.md §9
// using the latest precomputed signals.
func (s *Service) BurnoutWatchlist(ctx context.Context, tenantID uuid.UUID) (map[string]any, error) {
	rows, err := s.db.Query(ctx, `
		SELECT u.id, u.full_name, b.score, b.band, b.captured_at, b.signals
		FROM burnout_signals b
		JOIN users u ON u.id = b.user_id
		WHERE u.tenant_id = $1
		  AND b.captured_at = (
		      SELECT MAX(captured_at) FROM burnout_signals b2 WHERE b2.user_id = b.user_id
		  )
		ORDER BY b.score DESC LIMIT 100`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			uid     uuid.UUID
			name    string
			score   float64
			band    string
			cap     time.Time
			signals map[string]any
		)
		if err := rows.Scan(&uid, &name, &score, &band, &cap, &signals); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"user_id": uid, "name": name, "score": score, "band": band,
			"captured_at": cap, "signals": signals,
		})
	}
	return map[string]any{"watchlist": out}, nil
}

// ComputeForUser is invoked by the worker to refresh a user's burnout signal.
func (s *Service) ComputeForUser(ctx context.Context, userID uuid.UUID) (float64, string, error) {
	var (
		hoursLast7  float64
		concurrent  int
		missed      int
		afterHours  float64
		weekend     int
		prLag       float64
	)
	_ = s.db.QueryRow(ctx, `SELECT COALESCE(SUM(hours),0) FROM time_entries
		WHERE user_id=$1 AND work_date >= current_date - 7`, userID).Scan(&hoursLast7)
	_ = s.db.QueryRow(ctx, `SELECT COUNT(DISTINCT project_id) FROM project_members
		WHERE user_id=$1 AND removed_at IS NULL`, userID).Scan(&concurrent)
	_ = s.db.QueryRow(ctx, `SELECT COUNT(*) FROM tasks
		WHERE assignee_id=$1 AND due_on < current_date AND status NOT IN ('done','cancelled')`, userID).Scan(&missed)
	_ = s.db.QueryRow(ctx, `SELECT COALESCE(after_hours_pct,0) FROM productivity_metrics
		WHERE user_id=$1 ORDER BY captured_on DESC LIMIT 1`, userID).Scan(&afterHours)
	_ = s.db.QueryRow(ctx, `SELECT COUNT(*) FROM gh_commits
		WHERE author_user_id=$1 AND committed_at >= current_date - 30
		  AND EXTRACT(ISODOW FROM committed_at) IN (6,7)`, userID).Scan(&weekend)
	_ = s.db.QueryRow(ctx, `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (reviewed_at-created_at))/3600),0)
		FROM gh_pull_requests WHERE reviewer_user_id=$1 AND reviewed_at IS NOT NULL`, userID).Scan(&prLag)

	norm := func(v, ceiling float64) float64 {
		if ceiling == 0 {
			return 0
		}
		x := v / ceiling
		if x > 1 {
			return 1
		}
		return x
	}
	score := (norm(hoursLast7, 60)*0.20 +
		norm(float64(concurrent), 5)*0.15 +
		norm(float64(missed), 10)*0.15 +
		norm(afterHours, 0.5)*0.15 +
		norm(float64(weekend), 8)*0.10 +
		norm(prLag, 48)*0.10 +
		0.15*norm(float64(missed), 10)) * 100

	band := "healthy"
	switch {
	case score >= 80:
		band = "critical"
	case score >= 60:
		band = "elevated"
	case score >= 40:
		band = "watch"
	}

	_, err := s.db.Exec(ctx, `INSERT INTO burnout_signals (user_id, score, band, captured_at, signals)
		VALUES ($1,$2,$3, now(), $4::jsonb)`, userID, score, band, map[string]any{
		"hours_last_7":         hoursLast7,
		"concurrent_projects":  concurrent,
		"missed_deadlines":     missed,
		"after_hours_pct":      afterHours,
		"weekend_activity":     weekend,
		"pr_review_lag_hours":  prLag,
	})
	return score, band, err
}
