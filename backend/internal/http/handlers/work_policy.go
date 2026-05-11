// Package handlers — work_policy.go
//
// Tenant-configurable work-hours policy. Drives:
//   • the attendance "long away" warning (heartbeat detector)
//   • appraisal "on-time start" expectations
//   • the timezone the Attendance dashboard uses to bucket sessions
//
// Persisted under tenants.settings.work_policy as a JSON blob — same pattern
// the rest of the settings module uses, so a single tenant row carries
// everything an operator can tune from the UI.
package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/decapods/pgdp/backend/internal/audit"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type WorkPolicy struct {
	db *pgxpool.Pool
}

func NewWorkPolicy(db *pgxpool.Pool) *WorkPolicy { return &WorkPolicy{db: db} }

// WorkPolicySpec is the canonical shape stored on the tenant row. Public
// because the heartbeat handler (and any future appraisal worker) loads it
// via LoadWorkPolicy and reads these fields directly.
type WorkPolicySpec struct {
	// 0 = Sunday … 6 = Saturday. Default: Mon-Fri.
	WorkDays []int `json:"work_days"`
	// 24-hour clock. StartHour inclusive, EndHour exclusive.
	StartHour int `json:"start_hour"`
	EndHour   int `json:"end_hour"`
	// Daily break allowance in minutes — gaps up to this length during work
	// hours don't trigger an attendance warning.
	BreakMinutesPerDay int `json:"break_minutes_per_day"`
	// Anything beyond this size of unbroken gap during work hours fires a
	// long_away warning. Set ≥ BreakMinutesPerDay to give people a margin.
	AwayThresholdMinutes int `json:"away_threshold_minutes"`
	// IANA timezone string ("Africa/Lagos" etc). Falls back to the client's
	// reported zone when empty, then the server's local zone.
	Timezone string `json:"timezone"`
}

// DefaultWorkPolicy mirrors the previously hardcoded heartbeat logic so a
// fresh tenant behaves exactly like the old version until they tune it.
func DefaultWorkPolicy() WorkPolicySpec {
	return WorkPolicySpec{
		WorkDays:             []int{1, 2, 3, 4, 5},
		StartHour:            9,
		EndHour:              17,
		BreakMinutesPerDay:   60,
		AwayThresholdMinutes: 30,
		Timezone:             "",
	}
}

func (p *WorkPolicySpec) normalize() {
	d := DefaultWorkPolicy()
	if p.StartHour < 0 || p.StartHour > 23 {
		p.StartHour = d.StartHour
	}
	if p.EndHour <= p.StartHour || p.EndHour > 24 {
		p.EndHour = d.EndHour
	}
	if p.BreakMinutesPerDay < 0 || p.BreakMinutesPerDay > 240 {
		p.BreakMinutesPerDay = d.BreakMinutesPerDay
	}
	if p.AwayThresholdMinutes < 5 || p.AwayThresholdMinutes > 240 {
		p.AwayThresholdMinutes = d.AwayThresholdMinutes
	}
	// Dedupe + bound work days into the 0..6 window. Empty falls back to
	// Mon-Fri so attendance detection still has *some* schedule to evaluate.
	if len(p.WorkDays) == 0 {
		p.WorkDays = d.WorkDays
	} else {
		seen := map[int]bool{}
		clean := []int{}
		for _, d := range p.WorkDays {
			if d < 0 || d > 6 || seen[d] {
				continue
			}
			seen[d] = true
			clean = append(clean, d)
		}
		if len(clean) == 0 {
			clean = DefaultWorkPolicy().WorkDays
		}
		p.WorkDays = clean
	}
}

// LoadWorkPolicy reads the tenant's policy with sensible defaults filled in.
// Used by the heartbeat handler + any worker that cares about work hours.
func LoadWorkPolicy(ctx context.Context, db *pgxpool.Pool, tid uuid.UUID) WorkPolicySpec {
	out := DefaultWorkPolicy()
	var raw []byte
	if err := db.QueryRow(ctx, `SELECT settings FROM tenants WHERE id=$1`, tid).Scan(&raw); err != nil || len(raw) == 0 {
		return out
	}
	var s map[string]json.RawMessage
	if err := json.Unmarshal(raw, &s); err != nil {
		return out
	}
	wp, ok := s["work_policy"]
	if !ok {
		return out
	}
	_ = json.Unmarshal(wp, &out)
	out.normalize()
	return out
}

// IsWorkHour returns true when the given local hour (0-23) on the given
// weekday (0=Sun..6=Sat) falls inside the policy's window.
func (p WorkPolicySpec) IsWorkHour(weekday int, hour int) bool {
	day := false
	for _, d := range p.WorkDays {
		if d == weekday {
			day = true
			break
		}
	}
	if !day {
		return false
	}
	return hour >= p.StartHour && hour < p.EndHour
}

func (h *WorkPolicy) Get(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	c.JSON(http.StatusOK, LoadWorkPolicy(c.Request.Context(), h.db, tid))
}

func (h *WorkPolicy) Put(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var body WorkPolicySpec
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	body.normalize()
	patch, err := json.Marshal(map[string]any{"work_policy": body})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if _, err := h.db.Exec(c, `
		UPDATE tenants
		   SET settings   = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
		       updated_at = now()
		 WHERE id = $1`, tid, patch); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.WriteHTTP(c, h.db, c, tid, &uid, "settings.work_policy_changed", "tenant", tid, body)
	c.JSON(http.StatusOK, body)
}
