package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CheckinRollup serves the HR-facing daily check-in dashboard. Pivots
// daily_checkins × users × the window the caller asked for, plus a coarse
// attendance signal (was the user "online" anywhere during the day, via
// audit_log) and a count of tasks completed on the day so HR can read
// performance + compliance in one screen.
type CheckinRollup struct {
	db *pgxpool.Pool
}

func NewCheckinRollup(db *pgxpool.Pool) *CheckinRollup { return &CheckinRollup{db: db} }

// List — GET /api/v1/admin/daily-checkins?days=7
//
// Returns one item per (user, day) for the window, with the check-in fields
// when present and a `missed` flag when not. HR/governance-only.
func (h *CheckinRollup) List(c *gin.Context) {
	rolesRaw, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesRaw.([]string)
	if !hasAnyRole(roles, "super_admin", "hr", "ceo", "coo") {
		c.JSON(http.StatusForbidden, gin.H{"error": "HR / governance role required"})
		return
	}
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	days := 7
	if v, _ := strconv.Atoi(c.Query("days")); v > 0 && v <= 90 {
		days = v
	}
	from := time.Now().UTC().AddDate(0, 0, -days+1).Truncate(24 * time.Hour)
	fromStr := from.Format("2006-01-02")

	// Per-user roll-up. The check-in row may be null for a given day — left
	// joining lets us mark "missed" days for compliance counts on the SPA.
	rows, err := h.db.Query(c, `
		WITH user_days AS (
		  SELECT u.id AS user_id, u.full_name, u.email::text AS email, d::date AS day
		    FROM users u
		    CROSS JOIN generate_series($2::date, current_date, interval '1 day') AS d
		   WHERE u.tenant_id=$1 AND u.deleted_at IS NULL AND u.status='active'
		)
		SELECT ud.user_id, ud.full_name, ud.email, ud.day,
		       dc.mood, dc.focus_note, dc.yesterday_note,
		       COALESCE(dc.attachments, '[]'::jsonb),
		       dc.posted_to_campfire,
		       (
		         SELECT COUNT(*) FROM tasks t
		         WHERE t.assignee_id = ud.user_id
		           AND t.status = 'done'
		           AND t.updated_at::date = ud.day
		       ) AS tasks_done,
		       (
		         SELECT MIN(a.created_at) FROM audit_log a
		         WHERE a.actor_id = ud.user_id AND a.created_at::date = ud.day
		       ) AS first_seen_at
		FROM user_days ud
		LEFT JOIN daily_checkins dc ON dc.user_id = ud.user_id AND dc.day = ud.day
		ORDER BY ud.day DESC, ud.full_name ASC`, tid, fromStr)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	type rollupRow struct {
		UserID        uuid.UUID  `json:"user_id"`
		UserName      string     `json:"user_name"`
		Email         string     `json:"email"`
		Day           string     `json:"day"`
		Mood          *string    `json:"mood,omitempty"`
		FocusNote     *string    `json:"focus_note,omitempty"`
		YesterdayNote *string    `json:"yesterday_note,omitempty"`
		Attachments   any        `json:"attachments"`
		PostedShared  bool       `json:"posted_to_campfire"`
		Missed        bool       `json:"missed"`
		FirstSeenAt   *time.Time `json:"first_seen_at,omitempty"`
		TasksDone     int        `json:"tasks_done"`
	}

	out := []rollupRow{}
	for rows.Next() {
		var (
			uid                       uuid.UUID
			fullName, email           string
			day                       time.Time
			mood, focus, yesterday    *string
			attachments               []byte
			posted                    *bool
			tasksDone                 int
			firstSeen                 *time.Time
		)
		if err := rows.Scan(&uid, &fullName, &email, &day, &mood, &focus, &yesterday,
			&attachments, &posted, &tasksDone, &firstSeen); err != nil {
			continue
		}
		var attachJSON any
		if len(attachments) > 0 {
			attachJSON = json.RawMessage(attachments)
		} else {
			attachJSON = []any{}
		}
		row := rollupRow{
			UserID:      uid,
			UserName:    fullName,
			Email:       email,
			Day:         day.Format("2006-01-02"),
			Mood:        mood,
			FocusNote:   focus,
			YesterdayNote: yesterday,
			Attachments: attachJSON,
			TasksDone:   tasksDone,
			FirstSeenAt: firstSeen,
			Missed:      mood == nil && focus == nil && yesterday == nil,
		}
		if posted != nil {
			row.PostedShared = *posted
		}
		out = append(out, row)
	}

	c.JSON(http.StatusOK, gin.H{
		"items": out,
		"from":  fromStr,
		"days":  days,
	})
}

func hasAnyRole(have []string, want ...string) bool {
	for _, h := range have {
		for _, w := range want {
			if h == w {
				return true
			}
		}
	}
	return false
}
