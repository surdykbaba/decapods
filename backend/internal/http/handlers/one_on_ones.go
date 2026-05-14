package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/decapods/pgdp/backend/internal/auth"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// OneOnOnes — the manager + report 1-on-1 surface. One endpoint returns
// everything the dialog needs (identity, OKRs in the active cycle, recent
// daily check-ins, OKR check-ins, auto-derived talking points, the
// shared notes blob, prior sessions); another writes the notes blob;
// a third snapshots the current notes into a session and clears the pane.
//
// Authorisation rule across the file: the caller must be the report's
// manager (direct line — users.manager_id) or carry governance:write
// (admin override).
type OneOnOnes struct {
	db *pgxpool.Pool
}

func NewOneOnOnes(db *pgxpool.Pool) *OneOnOnes { return &OneOnOnes{db: db} }

// authorizeFor1on1 confirms the caller is allowed to see / edit this
// report's 1-on-1. Returns true when the rule holds; otherwise writes the
// 403 response and returns false so the caller can early-return.
func (h *OneOnOnes) authorizeFor1on1(c *gin.Context, reportID uuid.UUID) bool {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	if auth.HasPermission(roles, "governance:write") {
		return true
	}
	var managerID *uuid.UUID
	if err := h.db.QueryRow(c, `SELECT manager_id FROM users WHERE id=$1 AND tenant_id=$2`, reportID, tid).Scan(&managerID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "report not found"})
		return false
	}
	if managerID == nil || *managerID != uid {
		c.JSON(http.StatusForbidden, gin.H{"error": "you don't manage this person"})
		return false
	}
	return true
}

// Get bundles everything the 1-on-1 dialog renders in a single round-trip.
// Active cycle is the workspace's status='active' row; if none, the most
// recent planning cycle. Talking points are derived (not stored) — they're
// the smallest interesting signals about this report in the last 14 days.
func (h *OneOnOnes) Get(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	reportID, err := uuid.Parse(c.Param("reportID"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	if !h.authorizeFor1on1(c, reportID) {
		return
	}

	// Report identity.
	var (
		name, email, avatar, jobTitle string
		lastSeen                      *time.Time
		onLeaveToday                  bool
	)
	if err := h.db.QueryRow(c, `
		SELECT COALESCE(full_name,''), COALESCE(email::text,''), COALESCE(avatar_url,''),
		       COALESCE(job_title,''), last_seen_at,
		       EXISTS (
		         SELECT 1 FROM leave_requests
		         WHERE tenant_id=$1 AND user_id=$2 AND status='approved'
		           AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE
		       ) AS on_leave_today
		FROM users WHERE id=$2 AND tenant_id=$1`, tid, reportID).
		Scan(&name, &email, &avatar, &jobTitle, &lastSeen, &onLeaveToday); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "report not found"})
		return
	}

	// Active cycle (or most recent planning).
	var cycleID *uuid.UUID
	var cycleName, cycleStart, cycleEnd string
	_ = h.db.QueryRow(c, `
		SELECT id, name, starts_on::text, ends_on::text
		FROM okr_cycles WHERE tenant_id=$1
		ORDER BY (status='active') DESC, (status='planning') DESC, starts_on DESC
		LIMIT 1`, tid).Scan(&cycleID, &cycleName, &cycleStart, &cycleEnd)

	// Report's OKRs in that cycle. Lightweight projection — the SPA
	// already renders OKR cards on /okrs, here we just need a glance.
	okrs := []gin.H{}
	if cycleID != nil {
		rows, err := h.db.Query(c, `
			SELECT o.id, o.parent_id, o.kind, o.title, o.confidence, o.status,
			       o.current_value, o.target_value, COALESCE(o.unit,''), o.progress_pct,
			       (SELECT MAX(created_at) FROM okr_checkins kc WHERE kc.okr_id=o.id) AS latest_checkin
			FROM okrs o
			WHERE o.tenant_id=$1 AND o.cycle_id=$2 AND o.owner_id=$3
			ORDER BY o.kind ASC, o.position ASC`, tid, *cycleID, reportID)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var (
					id            uuid.UUID
					parentID      *uuid.UUID
					kind, title, confidence, status, unit string
					currentVal    float64
					targetVal     *float64
					progressPct   int
					latestCheckin *time.Time
				)
				if err := rows.Scan(&id, &parentID, &kind, &title, &confidence, &status,
					&currentVal, &targetVal, &unit, &progressPct, &latestCheckin); err == nil {
					okrs = append(okrs, gin.H{
						"id": id, "parent_id": parentID, "kind": kind, "title": title,
						"confidence": confidence, "status": status,
						"current_value": currentVal, "target_value": targetVal, "unit": unit,
						"progress_pct": progressPct,
						"latest_checkin_at": latestCheckin,
					})
				}
			}
		}
	}

	// Recent daily check-ins — last 14 days, newest first.
	dailies := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT day, COALESCE(mood,''), COALESCE(focus_note,''), COALESCE(yesterday_note,''),
		       COALESCE(tasks_done,0)
		FROM daily_checkins
		WHERE user_id=$1 AND day >= (CURRENT_DATE - INTERVAL '14 days')
		ORDER BY day DESC`, reportID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				day                   time.Time
				mood, focus, yest     string
				tasksDone             int
			)
			if err := rows.Scan(&day, &mood, &focus, &yest, &tasksDone); err == nil {
				dailies = append(dailies, gin.H{
					"day":            day.Format("2006-01-02"),
					"mood":           mood,
					"focus_note":     focus,
					"yesterday_note": yest,
					"tasks_done":     tasksDone,
				})
			}
		}
	}

	// Recent OKR check-ins — last 4 across all the report's OKRs.
	okrCheckins := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT kc.id, kc.okr_id, o.title, kc.percent, kc.confidence,
		       COALESCE(kc.status,''), COALESCE(kc.comment,''), kc.created_at
		FROM okr_checkins kc
		JOIN okrs o ON o.id = kc.okr_id
		WHERE kc.tenant_id=$1 AND kc.user_id=$2
		ORDER BY kc.created_at DESC
		LIMIT 4`, tid, reportID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				id, okrID  uuid.UUID
				title, status, comment, confidence string
				percent    int
				createdAt  time.Time
			)
			if err := rows.Scan(&id, &okrID, &title, &percent, &confidence, &status, &comment, &createdAt); err == nil {
				okrCheckins = append(okrCheckins, gin.H{
					"id": id, "okr_id": okrID, "okr_title": title,
					"percent": percent, "confidence": confidence,
					"status": status, "comment": comment,
					"created_at": createdAt,
				})
			}
		}
	}

	// Open + stuck tasks the report is on the hook for. Bounded so we
	// don't ship the whole backlog into the dialog.
	tasks := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT t.id, t.title, t.status, t.due_on, p.id, p.code, p.name
		FROM tasks t JOIN projects p ON p.id = t.project_id
		WHERE p.tenant_id=$1 AND t.assignee_id=$2 AND t.deleted_at IS NULL AND t.status <> 'done'
		ORDER BY (t.status='blocked') DESC,
		         (t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE) DESC,
		         t.due_on ASC NULLS LAST
		LIMIT 10`, tid, reportID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				tID, pID                   uuid.UUID
				title, status              string
				dueOn                      *time.Time
				code, projName             string
			)
			if err := rows.Scan(&tID, &title, &status, &dueOn, &pID, &code, &projName); err == nil {
				row := gin.H{
					"id": tID, "title": title, "status": status,
					"project": gin.H{"id": pID, "code": code, "name": projName},
				}
				if dueOn != nil {
					row["due_on"] = dueOn.Format("2006-01-02")
				}
				tasks = append(tasks, row)
			}
		}
	}

	// Auto-derived talking points. Cheap heuristics over the data we
	// already loaded above — saves the manager doing the diffing in
	// their head. Each point is a short imperative sentence that
	// answers "what should I bring up first?".
	talking := []gin.H{}
	now := time.Now().UTC()
	// Stale OKR check-ins.
	for _, o := range okrs {
		latest, _ := o["latest_checkin_at"].(*time.Time)
		title, _ := o["title"].(string)
		status, _ := o["status"].(string)
		if status == "done" || status == "dropped" {
			continue
		}
		if latest == nil {
			talking = append(talking, gin.H{
				"kind":  "stale_okr",
				"label": "No check-in yet on \"" + title + "\"",
				"href":  "/okrs",
			})
		} else if now.Sub(*latest) > 7*24*time.Hour {
			days := int(now.Sub(*latest).Hours() / 24)
			talking = append(talking, gin.H{
				"kind":  "stale_okr",
				"label": "\"" + title + "\" — last update " + itoaO(days) + "d ago",
				"href":  "/okrs",
			})
		}
		if status == "blocked" {
			talking = append(talking, gin.H{
				"kind":  "blocked_okr",
				"label": "Blocked OKR: \"" + title + "\"",
				"href":  "/okrs",
			})
		}
	}
	// Missed check-ins in the last 5 weekdays.
	missed := 0
	if rows, err := h.db.Query(c, `
		SELECT COUNT(*)::int FROM (
		  SELECT generate_series((CURRENT_DATE - INTERVAL '7 days')::date, CURRENT_DATE - 1, '1 day') AS d
		) g
		WHERE EXTRACT(ISODOW FROM g.d) < 6
		  AND NOT EXISTS (
		    SELECT 1 FROM daily_checkins dc
		    WHERE dc.user_id=$1 AND dc.day = g.d::date
		      AND (dc.mood IS NOT NULL OR dc.focus_note IS NOT NULL OR dc.yesterday_note IS NOT NULL)
		  )`, reportID); err == nil {
		defer rows.Close()
		if rows.Next() {
			_ = rows.Scan(&missed)
		}
	}
	if missed >= 2 {
		talking = append(talking, gin.H{
			"kind":  "missed_checkins",
			"label": "Missed " + itoaO(missed) + " daily check-ins in the past week",
		})
	}
	// Overdue / blocked tasks count.
	overdue, blocked := 0, 0
	for _, t := range tasks {
		if t["status"] == "blocked" {
			blocked++
		}
		if d, ok := t["due_on"].(string); ok && d != "" && d < now.Format("2006-01-02") {
			overdue++
		}
	}
	if blocked > 0 {
		talking = append(talking, gin.H{
			"kind":  "blocked_tasks",
			"label": itoaO(blocked) + " blocked task" + pluralS(blocked) + " — unblock?",
			"href":  "/me/work",
		})
	}
	if overdue > 0 {
		talking = append(talking, gin.H{
			"kind":  "overdue_tasks",
			"label": itoaO(overdue) + " overdue task" + pluralS(overdue),
			"href":  "/me/work",
		})
	}

	// Rolling notes pane (this manager + this report).
	var notesBody string
	var notesUpdated *time.Time
	_ = h.db.QueryRow(c, `
		SELECT body, updated_at FROM one_on_one_notes
		WHERE tenant_id=$1 AND manager_id=$2 AND report_id=$3`, tid, uid, reportID).
		Scan(&notesBody, &notesUpdated)

	// Past session log — last 5, newest first.
	sessions := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT id, notes, held_on, created_at FROM one_on_one_sessions
		WHERE tenant_id=$1 AND manager_id=$2 AND report_id=$3
		ORDER BY held_on DESC, created_at DESC
		LIMIT 5`, tid, uid, reportID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				id         uuid.UUID
				notes      string
				held       time.Time
				createdAt  time.Time
			)
			if err := rows.Scan(&id, &notes, &held, &createdAt); err == nil {
				sessions = append(sessions, gin.H{
					"id": id, "notes": notes,
					"held_on": held.Format("2006-01-02"),
					"created_at": createdAt,
				})
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"report": gin.H{
			"id": reportID, "name": name, "email": email, "avatar_url": avatar,
			"job_title": jobTitle, "last_seen_at": lastSeen, "on_leave_today": onLeaveToday,
		},
		"cycle":         gin.H{"id": cycleID, "name": cycleName, "starts_on": cycleStart, "ends_on": cycleEnd},
		"okrs":          okrs,
		"daily_checkins": dailies,
		"okr_checkins":  okrCheckins,
		"tasks":         tasks,
		"talking_points": talking,
		"notes": gin.H{
			"body":       notesBody,
			"updated_at": notesUpdated,
		},
		"past_sessions": sessions,
	})
}

// SaveNotes upserts the rolling notes blob for this (manager, report) pair.
func (h *OneOnOnes) SaveNotes(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	reportID, err := uuid.Parse(c.Param("reportID"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	if !h.authorizeFor1on1(c, reportID) {
		return
	}
	var req struct {
		Body string `json:"body"`
	}
	_ = c.ShouldBindJSON(&req)
	body := strings.TrimSpace(req.Body)
	if _, err := h.db.Exec(c, `
		INSERT INTO one_on_one_notes (tenant_id, manager_id, report_id, body)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (manager_id, report_id) DO UPDATE
		  SET body=EXCLUDED.body, updated_at=now()`,
		tid, uid, reportID, body); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// CloseSession snapshots the current notes into a session row and clears
// the rolling pane so the next 1-on-1 starts blank. Idempotent on its own
// (same notes saved twice = two session rows; we deliberately don't dedupe
// because the manager controls when to "close").
func (h *OneOnOnes) CloseSession(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	reportID, err := uuid.Parse(c.Param("reportID"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	if !h.authorizeFor1on1(c, reportID) {
		return
	}
	tx, err := h.db.Begin(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(c)
	var body string
	_ = tx.QueryRow(c, `
		SELECT body FROM one_on_one_notes
		WHERE tenant_id=$1 AND manager_id=$2 AND report_id=$3`, tid, uid, reportID).Scan(&body)
	if strings.TrimSpace(body) != "" {
		if _, err := tx.Exec(c, `
			INSERT INTO one_on_one_sessions (tenant_id, manager_id, report_id, notes)
			VALUES ($1,$2,$3,$4)`, tid, uid, reportID, body); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	if _, err := tx.Exec(c, `
		UPDATE one_on_one_notes SET body='', updated_at=now()
		WHERE tenant_id=$1 AND manager_id=$2 AND report_id=$3`,
		tid, uid, reportID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := tx.Commit(c); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// itoaO — local int-to-string for the talking-points loop. The file
// already imports nothing else that does this, so we keep a tiny helper
// rather than pulling in strconv.
func itoaO(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	if neg {
		return "-" + string(digits)
	}
	return string(digits)
}

// pluralS — local "s" pluraliser; the package already has another `plural`
// helper (notifications.go) with a different signature, so we rename ours
// to avoid the redeclaration.
func pluralS(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
