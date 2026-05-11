// Package handlers — attendance.go
//
// HR-only attendance + appraisal endpoints. All numbers are derived from data
// the platform already collects (heartbeats → attendance_sessions, tasks,
// time_entries, leave_requests, campfire_kudos, personal_updates). No new
// punch-clock UI for staff — attendance is inferred from how they use the app.
package handlers

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Attendance struct{ db *pgxpool.Pool }

func NewAttendance(db *pgxpool.Pool) *Attendance { return &Attendance{db: db} }

// Today — GET /api/v1/attendance/today
//
// One row per active user with today's first-seen, last-seen, total minutes
// online, primary device, and a derived label (on-time / late / not-yet-in /
// on-leave). HR scans this to know who's around right now.
func (h *Attendance) Today(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	rows, err := h.db.Query(c, `
		WITH today AS (
		  SELECT s.user_id,
		         MIN(s.started_at)   AS first_in,
		         MAX(s.last_seen_at) AS last_seen,
		         SUM(EXTRACT(EPOCH FROM (s.last_seen_at - s.started_at)))::int AS seconds_online,
		         MAX(s.platform)     AS platform,
		         MAX(s.os)           AS os,
		         MAX(s.browser)      AS browser
		    FROM attendance_sessions s
		   WHERE s.tenant_id = $1
		     AND s.last_seen_at::date = CURRENT_DATE
		   GROUP BY s.user_id
		),
		leave_today AS (
		  SELECT user_id FROM leave_requests
		   WHERE tenant_id = $1 AND status = 'approved'
		     AND CURRENT_DATE BETWEEN start_date AND end_date
		)
		SELECT u.id, COALESCE(u.full_name,''), u.email::text, COALESCE(u.avatar_url,''),
		       t.first_in, t.last_seen, COALESCE(t.seconds_online,0),
		       COALESCE(t.platform,''), COALESCE(t.os,''), COALESCE(t.browser,''),
		       (l.user_id IS NOT NULL) AS on_leave
		FROM users u
		LEFT JOIN today t       ON t.user_id = u.id
		LEFT JOIN leave_today l ON l.user_id = u.id
		WHERE u.tenant_id = $1 AND u.deleted_at IS NULL AND u.status = 'active'
		ORDER BY (t.first_in IS NULL), t.first_in ASC, u.full_name`, tid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id                              uuid.UUID
			name, email, avatar             string
			firstIn, lastSeen               *time.Time
			seconds                         int
			platform, osName, browser       string
			onLeave                         bool
		)
		if err := rows.Scan(&id, &name, &email, &avatar, &firstIn, &lastSeen,
			&seconds, &platform, &osName, &browser, &onLeave); err != nil {
			continue
		}
		label, tone := attendanceLabel(firstIn, lastSeen, seconds, onLeave)
		out = append(out, gin.H{
			"id": id, "name": name, "email": email, "avatar_url": avatar,
			"first_in": firstIn, "last_seen": lastSeen,
			"minutes_online": seconds / 60,
			"platform": platform, "os": osName, "browser": browser,
			"on_leave": onLeave,
			"label": label, "tone": tone,
		})
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// attendanceLabel summarises a person's day into one chip the HR view can
// render directly: on-leave / not-in / late / on-time / signed-off.
//
//	Late          first heartbeat after 10:00 local-server time
//	Signed off    last seen > 30 min ago (i.e. session closed)
//	Working       still active (open session)
func attendanceLabel(firstIn, lastSeen *time.Time, secondsOnline int, onLeave bool) (string, string) {
	if onLeave {
		return "On leave", "info"
	}
	if firstIn == nil {
		// Have they been seen ever today? No → not in yet (or whole day off).
		if time.Now().Hour() >= 11 {
			return "Not in", "bad"
		}
		return "Not in yet", "warn"
	}
	cutoff := time.Date(firstIn.Year(), firstIn.Month(), firstIn.Day(), 10, 0, 0, 0, firstIn.Location())
	late := firstIn.After(cutoff)
	if lastSeen != nil && time.Since(*lastSeen) > 30*time.Minute {
		if secondsOnline >= 6*3600 {
			return "Signed off", "neutral"
		}
		return "Stepped away", "warn"
	}
	if late {
		return "Late start", "warn"
	}
	return "Working", "good"
}

// Trend — GET /api/v1/attendance/trend?days=14
//
// Per-day workspace-wide attendance summary: unique active users, total hours,
// late-start count. Used for the dashboard sparkline.
func (h *Attendance) Trend(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	days := 14
	if v, _ := strconv.Atoi(c.Query("days")); v > 0 && v <= 90 {
		days = v
	}
	rows, err := h.db.Query(c, `
		WITH per_user_day AS (
		  SELECT user_id, date_trunc('day', last_seen_at)::date AS d,
		         MIN(started_at) AS first_in,
		         SUM(EXTRACT(EPOCH FROM (last_seen_at - started_at)))::float8 AS seconds
		    FROM attendance_sessions
		   WHERE tenant_id = $1 AND last_seen_at >= CURRENT_DATE - $2::int
		   GROUP BY user_id, d
		)
		SELECT d,
		       COUNT(*) AS users_active,
		       SUM(seconds)/3600.0 AS total_hours,
		       SUM(CASE WHEN EXTRACT(HOUR FROM first_in) >= 10 THEN 1 ELSE 0 END) AS late_count
		  FROM per_user_day
		 GROUP BY d
		 ORDER BY d`, tid, days)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			day        time.Time
			users      int
			totalHours float64
			lateCount  int
		)
		if err := rows.Scan(&day, &users, &totalHours, &lateCount); err == nil {
			out = append(out, gin.H{
				"day":          day,
				"users_active": users,
				"total_hours":  totalHours,
				"late_count":   lateCount,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// Insights — GET /api/v1/attendance/insights
//
// One-shot snapshot for the HR dashboard top tiles: active right now, avg
// daily hours over 30 days, on-time rate, devices split, etc.
func (h *Attendance) Insights(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	ctx := c.Request.Context()

	var activeNow, totalActive, onLeaveNow, lateToday int
	var avgHours30 float64
	_ = h.db.QueryRow(ctx, `
		SELECT COUNT(DISTINCT user_id) FROM attendance_sessions
		 WHERE tenant_id=$1 AND last_seen_at > now() - interval '5 minutes'`, tid).Scan(&activeNow)
	_ = h.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM users
		 WHERE tenant_id=$1 AND deleted_at IS NULL AND status='active'`, tid).Scan(&totalActive)
	_ = h.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM leave_requests
		 WHERE tenant_id=$1 AND status='approved'
		   AND CURRENT_DATE BETWEEN start_date AND end_date`, tid).Scan(&onLeaveNow)
	_ = h.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM (
		  SELECT user_id, MIN(started_at) AS first_in
		    FROM attendance_sessions
		   WHERE tenant_id=$1 AND last_seen_at::date = CURRENT_DATE
		   GROUP BY user_id
		) t WHERE EXTRACT(HOUR FROM first_in) >= 10`, tid).Scan(&lateToday)
	_ = h.db.QueryRow(ctx, `
		WITH per_user_day AS (
		  SELECT user_id, last_seen_at::date AS d,
		         SUM(EXTRACT(EPOCH FROM (last_seen_at - started_at)))::float8 AS s
		    FROM attendance_sessions
		   WHERE tenant_id=$1 AND last_seen_at >= CURRENT_DATE - 30
		   GROUP BY user_id, d
		)
		SELECT COALESCE(AVG(s)/3600.0, 0) FROM per_user_day`, tid).Scan(&avgHours30)

	// Device split (last 7d).
	devices := map[string]int{}
	dr, _ := h.db.Query(ctx, `
		SELECT COALESCE(NULLIF(platform,''),'other') AS platform, COUNT(DISTINCT user_id)
		  FROM attendance_sessions
		 WHERE tenant_id=$1 AND last_seen_at >= CURRENT_DATE - 7
		 GROUP BY platform`, tid)
	if dr != nil {
		defer dr.Close()
		for dr.Next() {
			var p string
			var n int
			if err := dr.Scan(&p, &n); err == nil {
				devices[p] = n
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"active_now":     activeNow,
		"total_active":   totalActive,
		"on_leave_today": onLeaveNow,
		"late_today":     lateToday,
		"avg_hours_30d":  avgHours30,
		"devices":        devices,
	})
}

// Appraisal — GET /api/v1/attendance/appraisal
//
// Member scorecards aggregated from existing platform signals. Numbers are
// suggestions for an HR conversation, not a verdict — each row carries the
// raw inputs so a manager can see *why* it landed where it did.
//
// Score weights (each 0-25, total 100):
//   attendance     30-day attendance rate vs. workdays
//   delivery       task completion rate
//   responsiveness mention/comment activity + daily updates
//   wellbeing      mood + leave balance use, penalised by attendance warnings
func (h *Attendance) Appraisal(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	// Cache: count of attendance_warnings per user in the last 30 days. Each
	// warning costs the member 2 points on the Wellbeing sub-score (capped at
	// 10 so a single bad month can't fully tank the score on its own).
	warnings := map[uuid.UUID]int{}
	if wRows, err := h.db.Query(c, `
		SELECT user_id, COUNT(*)::int FROM attendance_warnings
		 WHERE tenant_id=$1 AND created_at > now() - interval '30 days'
		 GROUP BY user_id`, tid); err == nil {
		defer wRows.Close()
		for wRows.Next() {
			var uid uuid.UUID
			var n int
			if err := wRows.Scan(&uid, &n); err == nil {
				warnings[uid] = n
			}
		}
	}

	rows, err := h.db.Query(c, `
		WITH last30 AS (
		  SELECT user_id,
		         COUNT(DISTINCT last_seen_at::date) AS days_present,
		         SUM(EXTRACT(EPOCH FROM (last_seen_at - started_at)))::float8 / 3600 AS hours_30
		    FROM attendance_sessions
		   WHERE tenant_id=$1 AND last_seen_at >= CURRENT_DATE - 30
		   GROUP BY user_id
		),
		tasks_done AS (
		  SELECT t.assignee_id AS user_id,
		         COUNT(*) FILTER (WHERE t.status='done' AND t.updated_at >= CURRENT_DATE - 30) AS done,
		         COUNT(*) FILTER (WHERE t.deleted_at IS NULL AND t.status<>'done') AS open,
		         COUNT(*) FILTER (WHERE t.deleted_at IS NULL AND t.status<>'done' AND t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE) AS overdue
		    FROM tasks t JOIN projects p ON p.id = t.project_id
		   WHERE p.tenant_id=$1 AND t.assignee_id IS NOT NULL
		   GROUP BY t.assignee_id
		),
		updates_30 AS (
		  SELECT user_id, COUNT(*) AS n
		    FROM personal_updates
		   WHERE tenant_id=$1 AND for_date >= CURRENT_DATE - 30
		   GROUP BY user_id
		),
		kudos_in AS (
		  SELECT to_user_id AS user_id, COUNT(*) AS n
		    FROM campfire_kudos
		   WHERE tenant_id=$1 AND created_at >= CURRENT_DATE - 30
		   GROUP BY to_user_id
		),
		mood_avg AS (
		  SELECT user_id, AVG(CASE mood
		    WHEN 'great' THEN 5 WHEN 'good' THEN 4 WHEN 'neutral' THEN 3
		    WHEN 'stressed' THEN 2 WHEN 'overloaded' THEN 1 END)::float8 AS m
		    FROM campfire_mood
		   WHERE tenant_id=$1 AND day >= CURRENT_DATE - 30
		   GROUP BY user_id
		)
		SELECT u.id, COALESCE(u.full_name,''), u.email::text, COALESCE(u.avatar_url,''),
		       COALESCE(l.days_present, 0), COALESCE(l.hours_30, 0),
		       COALESCE(t.done, 0),         COALESCE(t.open, 0),  COALESCE(t.overdue, 0),
		       COALESCE(up.n, 0),           COALESCE(k.n, 0),
		       m.m
		  FROM users u
		  LEFT JOIN last30     l  ON l.user_id  = u.id
		  LEFT JOIN tasks_done t  ON t.user_id  = u.id
		  LEFT JOIN updates_30 up ON up.user_id = u.id
		  LEFT JOIN kudos_in   k  ON k.user_id  = u.id
		  LEFT JOIN mood_avg   m  ON m.user_id  = u.id
		 WHERE u.tenant_id=$1 AND u.deleted_at IS NULL AND u.status='active'
		 ORDER BY u.full_name`, tid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	out := []gin.H{}
	for rows.Next() {
		var (
			uid                                       uuid.UUID
			name, email, avatar                       string
			daysPresent                               int
			hours30                                   float64
			tasksDone, tasksOpen, tasksOverdue        int
			updates, kudos                            int
			moodAvg                                   *float64
		)
		if err := rows.Scan(&uid, &name, &email, &avatar,
			&daysPresent, &hours30, &tasksDone, &tasksOpen, &tasksOverdue,
			&updates, &kudos, &moodAvg); err != nil {
			continue
		}

		// Subscores 0..25 each.
		// Attendance — 20 workdays in 30 calendar days is "full".
		attendance := clamp25(float64(daysPresent) / 20.0 * 25.0)
		// Delivery — completion ratio, penalised by overdue count.
		completion := 0.0
		if total := tasksDone + tasksOpen; total > 0 {
			completion = float64(tasksDone) / float64(total)
		}
		delivery := clamp25(completion*25.0 - float64(tasksOverdue)*1.5)
		// Responsiveness — updates + inbound kudos.
		respScore := float64(updates)*1.2 + float64(kudos)*2.5
		responsiveness := clamp25(respScore)
		// Wellbeing — mood avg out of 5, then docked for each attendance
		// warning in the last 30 days (max 10 point hit).
		wellbeing := 0.0
		if moodAvg != nil {
			wellbeing = clamp25(*moodAvg * 5.0)
		} else {
			wellbeing = 12 // no signal: middle of the road
		}
		warnCount := warnings[uid]
		warnPenalty := float64(warnCount) * 2.0
		if warnPenalty > 10 {
			warnPenalty = 10
		}
		wellbeing = clamp25(wellbeing - warnPenalty)
		total := attendance + delivery + responsiveness + wellbeing

		// One sentence of "auto goal" guidance — derived from the weakest area.
		goal := suggestGoal(attendance, delivery, responsiveness, wellbeing, tasksOverdue, daysPresent)
		if warnCount > 0 {
			goal = "Attendance flag: " + strconv.Itoa(warnCount) + " long-away warning" +
				plural(warnCount) + " in the last 30 days. " + goal
		}

		out = append(out, gin.H{
			"id": uid, "name": name, "email": email, "avatar_url": avatar,
			"days_present":   daysPresent,
			"hours_30":       hours30,
			"tasks_done":     tasksDone,
			"tasks_open":     tasksOpen,
			"tasks_overdue":  tasksOverdue,
			"updates_30":     updates,
			"kudos_in":       kudos,
			"mood_avg":       moodAvg,
			"warnings_30d":   warnCount,
			"scores": gin.H{
				"attendance":     round1(attendance),
				"delivery":       round1(delivery),
				"responsiveness": round1(responsiveness),
				"wellbeing":      round1(wellbeing),
				"total":          round1(total),
			},
			"suggested_goal": goal,
			"band":           band(total),
		})
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// suggestGoal picks the most useful next-step nudge based on the weakest
// dimension. Returns a short, action-oriented sentence the HR can copy into
// the appraisal note.
func suggestGoal(att, del, resp, well float64, overdue, daysPresent int) string {
	min := att
	tag := "attendance"
	if del < min { min = del; tag = "delivery" }
	if resp < min { min = resp; tag = "responsiveness" }
	if well < min { min = well; tag = "wellbeing" }
	switch tag {
	case "attendance":
		if daysPresent < 10 {
			return "Re-establish a consistent rhythm — aim for 18+ active days next month."
		}
		return "Tighten daily attendance — target on-time starts before 10:00."
	case "delivery":
		if overdue > 0 {
			return "Clear the " + strconv.Itoa(overdue) + " overdue task(s) and ship one new deliverable per week."
		}
		return "Pick up an additional deliverable next month and close at least 80% of assigned tasks."
	case "responsiveness":
		return "Submit a daily update at least 3× per week and engage in two Campfire threads."
	case "wellbeing":
		return "Schedule a 1:1 — mood signal is below the team baseline; check for blockers."
	}
	return "Maintain current performance and pick a stretch project for next quarter."
}

func band(total float64) string {
	switch {
	case total >= 85:
		return "Exceeding"
	case total >= 70:
		return "Strong"
	case total >= 55:
		return "On track"
	case total >= 40:
		return "Needs support"
	default:
		return "At risk"
	}
}

func clamp25(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 25 {
		return 25
	}
	return v
}

func round1(v float64) float64 {
	return float64(int(v*10+0.5)) / 10
}

// Warnings — GET /api/v1/attendance/warnings?status=open|all
//
// Recent attendance warnings (long-away gaps during work hours). The Today
// tab pulls open warnings to surface them as banners; appraisals only count
// the last-30-day window via the dedicated SQL above.
func (h *Attendance) Warnings(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	status := c.Query("status")
	if status == "" {
		status = "open"
	}
	args := []any{tid}
	q := `
		SELECT w.id, w.user_id, COALESCE(u.full_name,''), u.email::text, COALESCE(u.avatar_url,''),
		       w.kind, w.gap_minutes, w.started_at, w.ended_at,
		       w.notified_at, w.acknowledged_at, w.created_at
		  FROM attendance_warnings w
		  JOIN users u ON u.id = w.user_id
		 WHERE w.tenant_id=$1`
	if status == "open" {
		q += " AND w.acknowledged_at IS NULL"
	}
	q += " ORDER BY w.created_at DESC LIMIT 200"

	rows, err := h.db.Query(c, q, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id, uid             uuid.UUID
			name, email, avatar string
			kind                string
			gap                 int
			started             time.Time
			ended, notified, ack *time.Time
			created             time.Time
		)
		if err := rows.Scan(&id, &uid, &name, &email, &avatar,
			&kind, &gap, &started, &ended, &notified, &ack, &created); err == nil {
			out = append(out, gin.H{
				"id":              id,
				"user_id":         uid,
				"name":            name,
				"email":           email,
				"avatar_url":      avatar,
				"kind":            kind,
				"gap_minutes":     gap,
				"started_at":      started,
				"ended_at":        ended,
				"notified_at":     notified,
				"acknowledged_at": ack,
				"created_at":      created,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// AcknowledgeWarning — POST /api/v1/attendance/warnings/:id/ack
// Stamps acknowledged_at so the warning leaves the open list.
func (h *Attendance) AcknowledgeWarning(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	if _, err := h.db.Exec(c,
		`UPDATE attendance_warnings SET acknowledged_at=now()
		 WHERE id=$1 AND tenant_id=$2 AND acknowledged_at IS NULL`, id, tid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Member — GET /api/v1/attendance/member/:id
//
// Full attendance + appraisal detail for one person. Used by the member
// detail drawer on the Attendance page. Pulls last-30-days session timeline
// + the same scorecard the list view uses.
func (h *Attendance) Member(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}

	// Daily sessions in the last 30 days for the timeline strip.
	dr, _ := h.db.Query(c, `
		SELECT last_seen_at::date AS d,
		       MIN(started_at)   AS first_in,
		       MAX(last_seen_at) AS last_out,
		       SUM(EXTRACT(EPOCH FROM (last_seen_at - started_at)))::int AS seconds
		  FROM attendance_sessions
		 WHERE tenant_id=$1 AND user_id=$2 AND last_seen_at >= CURRENT_DATE - 30
		 GROUP BY d
		 ORDER BY d`, tid, uid)
	days := []gin.H{}
	if dr != nil {
		defer dr.Close()
		for dr.Next() {
			var d, in, out *time.Time
			var sec int
			if err := dr.Scan(&d, &in, &out, &sec); err == nil {
				days = append(days, gin.H{
					"day": d, "first_in": in, "last_out": out, "minutes": sec / 60,
				})
			}
		}
	}

	// Reuse the appraisal SQL but for a single user — easiest by passing it
	// through a tiny wrapper. To avoid duplicating the long CTE we just call
	// the same handler logic against a one-user filter via a transaction.
	scorecard := h.appraiseOne(c.Request.Context(), tid, uid)

	c.JSON(http.StatusOK, gin.H{
		"days":      days,
		"scorecard": scorecard,
	})
}

func (h *Attendance) appraiseOne(ctx context.Context, tid, uid uuid.UUID) gin.H {
	var (
		name, email, avatar                       string
		daysPresent                               int
		hours30                                   float64
		tasksDone, tasksOpen, tasksOverdue        int
		updates, kudos                            int
		moodAvg                                   *float64
	)
	err := h.db.QueryRow(ctx, `
		SELECT COALESCE(u.full_name,''), u.email::text, COALESCE(u.avatar_url,''),
		       COALESCE((SELECT COUNT(DISTINCT last_seen_at::date) FROM attendance_sessions WHERE tenant_id=$1 AND user_id=u.id AND last_seen_at >= CURRENT_DATE - 30), 0),
		       COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (last_seen_at - started_at)))::float8 / 3600 FROM attendance_sessions WHERE tenant_id=$1 AND user_id=u.id AND last_seen_at >= CURRENT_DATE - 30), 0),
		       COALESCE((SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.tenant_id=$1 AND t.assignee_id=u.id AND t.status='done' AND t.updated_at >= CURRENT_DATE - 30), 0),
		       COALESCE((SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.tenant_id=$1 AND t.assignee_id=u.id AND t.deleted_at IS NULL AND t.status<>'done'), 0),
		       COALESCE((SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.tenant_id=$1 AND t.assignee_id=u.id AND t.deleted_at IS NULL AND t.status<>'done' AND t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE), 0),
		       COALESCE((SELECT COUNT(*) FROM personal_updates WHERE tenant_id=$1 AND user_id=u.id AND for_date >= CURRENT_DATE - 30), 0),
		       COALESCE((SELECT COUNT(*) FROM campfire_kudos WHERE tenant_id=$1 AND to_user_id=u.id AND created_at >= CURRENT_DATE - 30), 0),
		       (SELECT AVG(CASE mood WHEN 'great' THEN 5 WHEN 'good' THEN 4 WHEN 'neutral' THEN 3 WHEN 'stressed' THEN 2 WHEN 'overloaded' THEN 1 END)::float8 FROM campfire_mood WHERE tenant_id=$1 AND user_id=u.id AND day >= CURRENT_DATE - 30)
		  FROM users u WHERE u.id = $2`,
		tid, uid).Scan(&name, &email, &avatar,
		&daysPresent, &hours30, &tasksDone, &tasksOpen, &tasksOverdue,
		&updates, &kudos, &moodAvg)
	if err != nil {
		return gin.H{}
	}

	attendance := clamp25(float64(daysPresent) / 20.0 * 25.0)
	completion := 0.0
	if total := tasksDone + tasksOpen; total > 0 {
		completion = float64(tasksDone) / float64(total)
	}
	delivery := clamp25(completion*25.0 - float64(tasksOverdue)*1.5)
	respScore := float64(updates)*1.2 + float64(kudos)*2.5
	responsiveness := clamp25(respScore)
	wellbeing := 12.0
	if moodAvg != nil {
		wellbeing = clamp25(*moodAvg * 5.0)
	}
	total := attendance + delivery + responsiveness + wellbeing
	goal := suggestGoal(attendance, delivery, responsiveness, wellbeing, tasksOverdue, daysPresent)

	return gin.H{
		"name": name, "email": email, "avatar_url": avatar,
		"days_present": daysPresent, "hours_30": hours30,
		"tasks_done": tasksDone, "tasks_open": tasksOpen, "tasks_overdue": tasksOverdue,
		"updates_30": updates, "kudos_in": kudos, "mood_avg": moodAvg,
		"scores": gin.H{
			"attendance":     round1(attendance),
			"delivery":       round1(delivery),
			"responsiveness": round1(responsiveness),
			"wellbeing":      round1(wellbeing),
			"total":          round1(total),
		},
		"suggested_goal": goal,
		"band":           band(total),
	}
}

// keep strings import busy in cases all dispatches collapse — guards against
// linters that flag the unused-import warning when SQL is the only consumer.
var _ = strings.TrimSpace
