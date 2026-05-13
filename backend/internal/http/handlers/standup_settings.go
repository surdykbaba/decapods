// Package handlers — standup_settings.go
//
// Workspace-wide daily standup configuration. Stored in tenants.settings at
// the top level (alongside standup_at, which existed before this file) so
// the existing standupTimeFor helper and the huddleResp keep their shape.
//
// Three values live here:
//   • standup_at           — HH:MM (24h). Default "09:30".
//   • standup_window_before — minutes BEFORE standup_at that the SPA's
//                              standup card surfaces as actionable.
//                              Default 30.
//   • standup_window_after  — minutes AFTER standup_at that the late-status
//                              buttons remain visible. Default 60.
//
// The window values let admins widen the "is the standup card live?"
// period for, say, an async team that wants the buttons available all
// morning. Outside the window the card still renders, but only as a quiet
// "Next standup at 09:30" hint — that's a frontend decision driven by these
// numbers.
package handlers

import (
	"encoding/json"
	"net/http"
	"regexp"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type StandupAdmin struct {
	db *pgxpool.Pool
}

func NewStandupAdmin(db *pgxpool.Pool) *StandupAdmin { return &StandupAdmin{db: db} }

type standupSettings struct {
	StandupAt    string `json:"standup_at"`
	WindowBefore int    `json:"window_before_min"`
	WindowAfter  int    `json:"window_after_min"`
}

var standupTimeRe = regexp.MustCompile(`^[0-2][0-9]:[0-5][0-9]$`)

// Defaults — match standupTimeFor in huddle.go for the time, and pick
// pragmatic 30/60 minute windows so the card has a useful default reach.
const (
	defaultStandupAt           = "09:30"
	defaultStandupWindowBefore = 30
	defaultStandupWindowAfter  = 60
)

// Get — GET /api/v1/settings/standup
func (h *StandupAdmin) Get(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	out := standupSettings{
		StandupAt:    defaultStandupAt,
		WindowBefore: defaultStandupWindowBefore,
		WindowAfter:  defaultStandupWindowAfter,
	}
	var raw []byte
	if err := h.db.QueryRow(c, `SELECT settings FROM tenants WHERE id=$1`, tid).Scan(&raw); err == nil && len(raw) > 0 {
		var s map[string]any
		_ = json.Unmarshal(raw, &s)
		if v, ok := s["standup_at"].(string); ok && standupTimeRe.MatchString(v) {
			out.StandupAt = v
		}
		if v, ok := s["standup_window_before_min"].(float64); ok && v > 0 {
			out.WindowBefore = int(v)
		}
		if v, ok := s["standup_window_after_min"].(float64); ok && v > 0 {
			out.WindowAfter = int(v)
		}
	}
	c.JSON(http.StatusOK, out)
}

// Put — PUT /api/v1/settings/standup
//
// Body: { standup_at: "HH:MM", window_before_min: int, window_after_min: int }
// All three are validated; empty / out-of-range values fall back to defaults
// rather than 400-ing so a partial save can't accidentally brick the widget.
func (h *StandupAdmin) Put(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var body standupSettings
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Time: HH:MM (24-hour). Fall back to default on a bad value rather than
	// reject — same UX as the read path, prevents a typo from leaving the
	// widget invisible for the whole workspace.
	if !standupTimeRe.MatchString(body.StandupAt) {
		body.StandupAt = defaultStandupAt
	}
	// Windows: clamp to sane bounds. 0–240 minutes is plenty for either
	// side; bigger numbers mean the "live" period takes over the whole
	// page, which isn't useful.
	if body.WindowBefore < 0 {
		body.WindowBefore = defaultStandupWindowBefore
	}
	if body.WindowBefore > 240 {
		body.WindowBefore = 240
	}
	if body.WindowAfter < 0 {
		body.WindowAfter = defaultStandupWindowAfter
	}
	if body.WindowAfter > 240 {
		body.WindowAfter = 240
	}

	patch, err := json.Marshal(map[string]any{
		"standup_at":                body.StandupAt,
		"standup_window_before_min": body.WindowBefore,
		"standup_window_after_min":  body.WindowAfter,
	})
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
	c.JSON(http.StatusOK, body)
}

// loadStandupWindows — convenience for the huddle handler. Pulls the two
// window values from tenants.settings with the same defaulting that Get
// applies. Returns (before, after) in minutes.
func loadStandupWindows(c *gin.Context, db *pgxpool.Pool, tid uuid.UUID) (int, int) {
	before, after := defaultStandupWindowBefore, defaultStandupWindowAfter
	var raw []byte
	if err := db.QueryRow(c, `SELECT settings FROM tenants WHERE id=$1`, tid).Scan(&raw); err == nil && len(raw) > 0 {
		var s map[string]any
		_ = json.Unmarshal(raw, &s)
		if v, ok := s["standup_window_before_min"].(float64); ok && v > 0 {
			before = int(v)
		}
		if v, ok := s["standup_window_after_min"].(float64); ok && v > 0 {
			after = int(v)
		}
	}
	if before > 240 {
		before = 240
	}
	if after > 240 {
		after = 240
	}
	return before, after
}
