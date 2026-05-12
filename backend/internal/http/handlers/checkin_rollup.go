package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
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
	limit := 50
	if v, _ := strconv.Atoi(c.Query("limit")); v > 0 && v <= 200 {
		limit = v
	}
	offset := 0
	if v, _ := strconv.Atoi(c.Query("offset")); v >= 0 {
		offset = v
	}
	from := time.Now().UTC().AddDate(0, 0, -days+1).Truncate(24 * time.Hour)
	fromStr := from.Format("2006-01-02")

	// Optional filters on detail rows.
	userQ := strings.TrimSpace(c.Query("user"))
	missedOnly := c.Query("missed") == "1"

	// Per-user roll-up. The check-in row may be null for a given day — left
	// joining lets us mark "missed" days for compliance counts on the SPA.
	// Filtered rows still come from the same base set; compliance summary
	// (computed below) ignores user/missed filters so HR always sees the
	// full team picture.
	base := `
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
		LEFT JOIN daily_checkins dc ON dc.user_id = ud.user_id AND dc.day = ud.day`

	args := []any{tid, fromStr}
	where := ""
	if userQ != "" {
		args = append(args, "%"+userQ+"%")
		n := strconv.Itoa(len(args))
		where += " WHERE (ud.full_name ILIKE $" + n + " OR ud.email ILIKE $" + n + ")"
	}
	if missedOnly {
		if where == "" {
			where += " WHERE "
		} else {
			where += " AND "
		}
		where += "dc.user_id IS NULL"
	}

	// Total count for pagination (over filtered detail rows).
	var total int
	if err := h.db.QueryRow(c,
		`SELECT COUNT(*) FROM (`+base+where+`) sub`, args...,
	).Scan(&total); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	args = append(args, limit, offset)
	rows, err := h.db.Query(c, base+where+
		" ORDER BY ud.day DESC, ud.full_name ASC LIMIT $"+strconv.Itoa(len(args)-1)+
		" OFFSET $"+strconv.Itoa(len(args)), args...)
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

	// Compliance summary — always full team, never filtered. HR needs the
	// overall picture even when the detail table is narrowed to one person.
	type complianceRow struct {
		UserID    uuid.UUID `json:"user_id"`
		UserName  string    `json:"user_name"`
		Email     string    `json:"email"`
		Done      int       `json:"done"`
		Missed    int       `json:"missed"`
		TasksDone int       `json:"tasks_done"`
		Streak    int       `json:"streak"` // current consecutive check-in days, today-anchored
		LastMood  *string   `json:"last_mood,omitempty"`
	}
	compliance := []complianceRow{}
	moodCounts := map[string]int{}
	totalDone, totalMissed := 0, 0
	if crows, err := h.db.Query(c, `
		WITH user_days AS (
		  SELECT u.id AS user_id, u.full_name, u.email::text AS email, d::date AS day
		    FROM users u
		    CROSS JOIN generate_series($2::date, current_date, interval '1 day') AS d
		   WHERE u.tenant_id=$1 AND u.deleted_at IS NULL AND u.status='active'
		),
		joined AS (
		  SELECT ud.user_id, ud.full_name, ud.email, ud.day,
		         dc.mood IS NOT NULL OR dc.focus_note IS NOT NULL OR dc.yesterday_note IS NOT NULL AS checked_in,
		         dc.mood
		  FROM user_days ud
		  LEFT JOIN daily_checkins dc ON dc.user_id = ud.user_id AND dc.day = ud.day
		)
		SELECT user_id, full_name, email,
		       SUM(CASE WHEN checked_in THEN 1 ELSE 0 END) AS done,
		       SUM(CASE WHEN checked_in THEN 0 ELSE 1 END) AS missed,
		       (
		         SELECT COUNT(*) FROM tasks t
		         WHERE t.assignee_id = user_id AND t.status = 'done'
		           AND t.updated_at::date >= $2::date
		       ) AS tasks_done,
		       (
		         SELECT mood FROM daily_checkins
		          WHERE user_id = joined.user_id AND mood IS NOT NULL
		          ORDER BY day DESC LIMIT 1
		       ) AS last_mood
		FROM joined
		GROUP BY user_id, full_name, email
		ORDER BY missed DESC, full_name ASC`, tid, fromStr); err == nil {
		defer crows.Close()
		for crows.Next() {
			var (
				uid               uuid.UUID
				name, email       string
				done, missed, td  int
				lastMood          *string
			)
			if err := crows.Scan(&uid, &name, &email, &done, &missed, &td, &lastMood); err != nil {
				continue
			}
			totalDone += done
			totalMissed += missed
			if lastMood != nil && *lastMood != "" {
				moodCounts[*lastMood]++
			}
			compliance = append(compliance, complianceRow{
				UserID: uid, UserName: name, Email: email,
				Done: done, Missed: missed, TasksDone: td, LastMood: lastMood,
			})
		}
	}

	// Streak per user — consecutive days from today backwards where they
	// checked in. Single query that returns user_id + streak.
	if srows, err := h.db.Query(c, `
		WITH gaps AS (
		  SELECT u.id AS user_id,
		         (SELECT MAX(d) FROM (
		            SELECT generate_series(current_date - interval '90 days', current_date, '1 day')::date AS d
		         ) ds
		         WHERE NOT EXISTS (
		           SELECT 1 FROM daily_checkins dc
		            WHERE dc.user_id = u.id AND dc.day = ds.d
		         ) AND ds.d <= current_date) AS last_miss
		    FROM users u
		   WHERE u.tenant_id=$1 AND u.deleted_at IS NULL AND u.status='active'
		)
		SELECT user_id,
		       CASE
		         WHEN last_miss IS NULL THEN 90
		         ELSE GREATEST(0, (current_date - last_miss)::int)
		       END AS streak
		  FROM gaps`, tid); err == nil {
		streaks := map[uuid.UUID]int{}
		defer srows.Close()
		for srows.Next() {
			var uid uuid.UUID
			var streak int
			if err := srows.Scan(&uid, &streak); err == nil {
				streaks[uid] = streak
			}
		}
		for i := range compliance {
			compliance[i].Streak = streaks[compliance[i].UserID]
		}
	}

	// At-risk count for the headline — anyone who missed > half the window.
	atRisk := 0
	for _, p := range compliance {
		if p.Missed > p.Done && p.Done+p.Missed > 0 {
			atRisk++
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"items":      out,
		"total":      total,
		"limit":      limit,
		"offset":     offset,
		"from":       fromStr,
		"days":       days,
		"compliance": compliance,
		"insights": gin.H{
			"total_done":   totalDone,
			"total_missed": totalMissed,
			"at_risk":      atRisk,
			"mood_counts":  moodCounts,
			"members":      len(compliance),
		},
	})
}

// Self — GET /api/v1/me/daily-checkins?days=30
//
// Personal check-in history for the calling user. No role check — every user
// can read their own. Same shape as the rollup row but only their entries.
func (h *CheckinRollup) Self(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)

	days := 30
	if v, _ := strconv.Atoi(c.Query("days")); v > 0 && v <= 180 {
		days = v
	}
	from := time.Now().UTC().AddDate(0, 0, -days+1).Truncate(24 * time.Hour)
	fromStr := from.Format("2006-01-02")

	rows, err := h.db.Query(c, `
		WITH days AS (
		  SELECT d::date AS day
		    FROM generate_series($3::date, current_date, interval '1 day') AS d
		)
		SELECT days.day,
		       dc.mood, dc.focus_note, dc.yesterday_note,
		       COALESCE(dc.attachments, '[]'::jsonb),
		       dc.posted_to_campfire,
		       (
		         SELECT COUNT(*) FROM tasks t
		         WHERE t.assignee_id = $2 AND t.status = 'done'
		           AND t.updated_at::date = days.day
		       ) AS tasks_done
		FROM days
		LEFT JOIN daily_checkins dc ON dc.user_id = $2 AND dc.day = days.day
		ORDER BY days.day DESC`, tid, uid, fromStr)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	type selfRow struct {
		Day           string  `json:"day"`
		Mood          *string `json:"mood,omitempty"`
		FocusNote     *string `json:"focus_note,omitempty"`
		YesterdayNote *string `json:"yesterday_note,omitempty"`
		Attachments   any     `json:"attachments"`
		PostedShared  bool    `json:"posted_to_campfire"`
		Missed        bool    `json:"missed"`
		TasksDone     int     `json:"tasks_done"`
	}
	out := []selfRow{}
	done, missed := 0, 0
	moodCounts := map[string]int{}
	totalTasks := 0
	for rows.Next() {
		var (
			day                    time.Time
			mood, focus, yesterday *string
			attachments            []byte
			posted                 *bool
			tasksDone              int
		)
		if err := rows.Scan(&day, &mood, &focus, &yesterday, &attachments, &posted, &tasksDone); err != nil {
			continue
		}
		var attachJSON any = []any{}
		if len(attachments) > 0 {
			attachJSON = json.RawMessage(attachments)
		}
		row := selfRow{
			Day: day.Format("2006-01-02"),
			Mood: mood, FocusNote: focus, YesterdayNote: yesterday,
			Attachments: attachJSON,
			Missed:      mood == nil && focus == nil && yesterday == nil,
			TasksDone:   tasksDone,
		}
		if posted != nil {
			row.PostedShared = *posted
		}
		if row.Missed {
			missed++
		} else {
			done++
		}
		if mood != nil && *mood != "" {
			moodCounts[*mood]++
		}
		totalTasks += tasksDone
		out = append(out, row)
	}

	c.JSON(http.StatusOK, gin.H{
		"items": out,
		"from":  fromStr,
		"days":  days,
		"insights": gin.H{
			"done":        done,
			"missed":      missed,
			"tasks_done":  totalTasks,
			"mood_counts": moodCounts,
		},
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
