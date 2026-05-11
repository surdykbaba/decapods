package handlers

import (
	"net/http"
	"strings"
	"time"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Profile returns the rich member profile bundle used by /members/:id on the
// HR side. Aggregates identity, workload, leave balances + recent requests,
// attendance pulse (last 14 days), mood trend, and recent audit/campfire
// activity in a single response so the SPA doesn't fan out.
//
// Authorisation: any signed-in member of the tenant. Sensitive admin-only
// actions (reset password, change MFA-required) live on their own gated
// endpoints — what this returns is read-only and matches the data the
// member's row in /members already exposes.
func (h *Members) Profile(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}

	// ---- Identity ----
	var (
		email, name, avatar               string
		status                            string
		mfaEnabled, mfaRequired           bool
		createdAt                         time.Time
		lastLogin, lastSeen, deletedAt    *time.Time
		manualStatus                      *string
	)
	if err := h.db.QueryRow(c, `
		SELECT email::text, COALESCE(full_name,''), COALESCE(avatar_url,''),
		       COALESCE(status,'active'),
		       COALESCE(mfa_enabled,false), COALESCE(mfa_required,false),
		       created_at, last_login_at, last_seen_at, deleted_at,
		       manual_status
		FROM users WHERE id=$1 AND tenant_id=$2`, id, tid).Scan(
		&email, &name, &avatar, &status,
		&mfaEnabled, &mfaRequired,
		&createdAt, &lastLogin, &lastSeen, &deletedAt,
		&manualStatus,
	); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "member not found"})
		return
	}
	if deletedAt != nil {
		status = "disabled"
	}

	// Roles
	roles := []string{}
	if rows, err := h.db.Query(c, `
		SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
		WHERE ur.user_id=$1 ORDER BY r.name`, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var r string
			if err := rows.Scan(&r); err == nil {
				roles = append(roles, r)
			}
		}
	}

	// ---- Workload (tasks + projects) ----
	type byStatus struct {
		Todo       int `json:"todo"`
		InProgress int `json:"in_progress"`
		Blocked    int `json:"blocked"`
		Review     int `json:"review"`
		Done       int `json:"done"`
	}
	var bs byStatus
	_ = h.db.QueryRow(c, `
		SELECT
		  COUNT(*) FILTER (WHERE t.status='todo'),
		  COUNT(*) FILTER (WHERE t.status='in_progress'),
		  COUNT(*) FILTER (WHERE t.status='blocked'),
		  COUNT(*) FILTER (WHERE t.status='review'),
		  COUNT(*) FILTER (WHERE t.status='done' AND t.updated_at >= now() - interval '30 days')
		FROM tasks t JOIN projects p ON p.id = t.project_id
		WHERE p.tenant_id=$1 AND t.assignee_id=$2 AND t.deleted_at IS NULL`,
		tid, id).Scan(&bs.Todo, &bs.InProgress, &bs.Blocked, &bs.Review, &bs.Done)

	var overdue, dueSoon int
	_ = h.db.QueryRow(c, `
		SELECT
		  COUNT(*) FILTER (WHERE t.due_on < CURRENT_DATE AND t.status NOT IN ('done')),
		  COUNT(*) FILTER (WHERE t.due_on BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' AND t.status NOT IN ('done'))
		FROM tasks t JOIN projects p ON p.id = t.project_id
		WHERE p.tenant_id=$1 AND t.assignee_id=$2 AND t.deleted_at IS NULL`,
		tid, id).Scan(&overdue, &dueSoon)

	type projRow struct {
		ID, Name string
		Role     string
		Allocation int
	}
	projects := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT p.id, p.name, COALESCE(pm.role,''), COALESCE(pm.allocation,0)
		FROM project_members pm
		JOIN projects p ON p.id = pm.project_id
		WHERE pm.user_id=$1 AND pm.removed_at IS NULL
		  AND p.tenant_id=$2 AND p.deleted_at IS NULL
		  AND p.status NOT IN ('paid','closed','archived')
		ORDER BY p.updated_at DESC LIMIT 20`, id, tid); err == nil {
		defer rows.Close()
		for rows.Next() {
			var pr projRow
			if err := rows.Scan(&pr.ID, &pr.Name, &pr.Role, &pr.Allocation); err == nil {
				projects = append(projects, gin.H{
					"id": pr.ID, "name": pr.Name, "role": pr.Role, "allocation": pr.Allocation,
				})
			}
		}
	}

	// Total allocation across active projects.
	totalAllocation := 0
	for _, p := range projects {
		if a, ok := p["allocation"].(int); ok {
			totalAllocation += a
		}
	}

	// ---- Leave ----
	balances := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT lt.name, lt.paid,
		       COALESCE(lb.accrued_days,lt.default_days),
		       COALESCE(lb.carryover_days,0),
		       COALESCE(lb.used_days,0),
		       (COALESCE(lb.accrued_days,lt.default_days) + COALESCE(lb.carryover_days,0) - COALESCE(lb.used_days,0)) AS remaining
		FROM leave_types lt
		LEFT JOIN leave_balances lb ON lb.leave_type_id = lt.id AND lb.user_id = $2 AND lb.year = EXTRACT(YEAR FROM CURRENT_DATE)::int
		WHERE lt.tenant_id=$1 AND lt.active=true
		ORDER BY lt.name`, tid, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var name string
			var paid bool
			var accrued, carry, used, remaining float64
			if err := rows.Scan(&name, &paid, &accrued, &carry, &used, &remaining); err == nil {
				balances = append(balances, gin.H{
					"name": name, "paid": paid,
					"accrued": accrued, "carryover": carry,
					"used": used, "remaining": remaining,
				})
			}
		}
	}

	leaveRequests := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT r.id, lt.name, r.start_date, r.end_date, r.days, r.status, r.reason
		FROM leave_requests r
		JOIN leave_types lt ON lt.id = r.leave_type_id
		WHERE r.tenant_id=$1 AND r.user_id=$2
		ORDER BY r.start_date DESC LIMIT 8`, tid, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				rid uuid.UUID
				typeName, status, reason string
				start, end               time.Time
				days                     float64
			)
			if err := rows.Scan(&rid, &typeName, &start, &end, &days, &status, &reason); err == nil {
				leaveRequests = append(leaveRequests, gin.H{
					"id": rid, "type_name": typeName,
					"start_date": start.Format("2006-01-02"),
					"end_date":   end.Format("2006-01-02"),
					"days": days, "status": status, "reason": reason,
				})
			}
		}
	}

	var onLeaveToday bool
	_ = h.db.QueryRow(c, `
		SELECT EXISTS (
		  SELECT 1 FROM leave_requests
		  WHERE tenant_id=$1 AND user_id=$2 AND status='approved'
		    AND CURRENT_DATE BETWEEN start_date AND end_date
		)`, tid, id).Scan(&onLeaveToday)

	var daysOffYTD float64
	_ = h.db.QueryRow(c, `
		SELECT COALESCE(SUM(days), 0) FROM leave_requests
		WHERE tenant_id=$1 AND user_id=$2 AND status='approved'
		  AND EXTRACT(YEAR FROM start_date) = EXTRACT(YEAR FROM CURRENT_DATE)`,
		tid, id).Scan(&daysOffYTD)

	// ---- Attendance pulse (last 14 days) ----
	attendance := []gin.H{}
	if rows, err := h.db.Query(c, `
		WITH days AS (
		  SELECT generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day')::date AS d
		)
		SELECT d.d AS day,
		       COALESCE(SUM(EXTRACT(EPOCH FROM (s.last_seen_at - s.started_at))) / 3600.0, 0) AS hours,
		       COUNT(s.*) AS sessions,
		       MIN(s.started_at AT TIME ZONE 'UTC')::time AS first_seen
		FROM days d
		LEFT JOIN attendance_sessions s
		  ON s.user_id = $1
		 AND s.tenant_id = $2
		 AND s.started_at::date = d.d
		GROUP BY d.d
		ORDER BY d.d ASC`, id, tid); err == nil {
		defer rows.Close()
		for rows.Next() {
			var day time.Time
			var hours float64
			var sessions int
			var firstSeen *time.Time
			if err := rows.Scan(&day, &hours, &sessions, &firstSeen); err == nil {
				first := ""
				if firstSeen != nil {
					first = firstSeen.Format("15:04")
				}
				attendance = append(attendance, gin.H{
					"day":        day.Format("2006-01-02"),
					"hours":      hours,
					"sessions":   sessions,
					"first_seen": first,
				})
			}
		}
	}

	// ---- Mood trend (last 14 days from daily_checkins) ----
	moods := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT day, COALESCE(mood,''), COALESCE(focus_note,'')
		FROM daily_checkins
		WHERE user_id=$1 AND day >= CURRENT_DATE - INTERVAL '13 days'
		ORDER BY day ASC`, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var day time.Time
			var mood, focus string
			if err := rows.Scan(&day, &mood, &focus); err == nil {
				if len(focus) > 140 {
					focus = focus[:140] + "…"
				}
				moods = append(moods, gin.H{
					"day": day.Format("2006-01-02"), "mood": mood, "focus": focus,
				})
			}
		}
	}

	// ---- Recent activity (audit_log where they were the actor) ----
	activity := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT action, entity, entity_id, created_at, COALESCE(diff::text,'{}')
		FROM audit_log
		WHERE tenant_id=$1 AND actor_id=$2
		ORDER BY created_at DESC LIMIT 20`, tid, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				action, entity, diffTxt string
				eid uuid.UUID
				at  time.Time
			)
			if err := rows.Scan(&action, &entity, &eid, &at, &diffTxt); err == nil {
				activity = append(activity, gin.H{
					"action": action, "entity": entity, "entity_id": eid,
					"created_at": at,
				})
			}
		}
	}

	// ---- Recent campfire posts authored ----
	campfire := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT id, kind, COALESCE(title,''), body, created_at
		FROM campfire_posts
		WHERE tenant_id=$1 AND author_id=$2
		ORDER BY created_at DESC LIMIT 5`, tid, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				pid              uuid.UUID
				kind, title, body string
				at               time.Time
			)
			if err := rows.Scan(&pid, &kind, &title, &body, &at); err == nil {
				if len(body) > 200 {
					body = body[:200] + "…"
				}
				campfire = append(campfire, gin.H{
					"id": pid, "kind": kind, "title": title, "body": body,
					"created_at": at,
				})
			}
		}
	}

	// Presence — derive a simple bucket from last_seen_at so the SPA doesn't
	// have to re-compute it. Mirrors the rule used in /members.
	presence := "offline"
	var secondsSince int64 = -1
	if lastSeen != nil {
		secondsSince = int64(time.Since(*lastSeen).Seconds())
		switch {
		case secondsSince < 120:
			presence = "online"
		case secondsSince < 600:
			presence = "away"
		}
	}
	if manualStatus != nil && strings.TrimSpace(*manualStatus) != "" && presence != "offline" {
		presence = *manualStatus
	}

	openTasks := bs.Todo + bs.InProgress + bs.Review

	c.JSON(http.StatusOK, gin.H{
		"id":             id,
		"email":          email,
		"name":           name,
		"avatar_url":     avatar,
		"status":         status,
		"mfa_enabled":    mfaEnabled,
		"mfa_required":   mfaRequired,
		"created_at":     createdAt,
		"last_login_at":  lastLogin,
		"last_seen_at":   lastSeen,
		"seconds_since":  secondsSince,
		"presence":       presence,
		"roles":          roles,

		"workload": gin.H{
			"projects":          projects,
			"active_projects":   len(projects),
			"total_allocation":  totalAllocation,
			"open_tasks":        openTasks,
			"overdue_tasks":     overdue,
			"due_soon_tasks":    dueSoon,
			"completed_30d":     bs.Done,
			"by_status":         bs,
		},

		"leave": gin.H{
			"balances":         balances,
			"recent_requests":  leaveRequests,
			"on_leave_today":   onLeaveToday,
			"days_off_ytd":     daysOffYTD,
		},

		"attendance_14d": attendance,
		"mood_14d":       moods,
		"recent_activity": activity,
		"recent_campfire": campfire,
	})
}
