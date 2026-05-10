package handlers

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Me hosts the per-user personal portal endpoints. Every handler here is
// scoped to the authenticated user — never returns tenant-wide data.
type Me struct{ db *pgxpool.Pool }

func NewMe(db *pgxpool.Pool) *Me { return &Me{db: db} }

/* ---------- Dashboard ---------- */

// Work returns a single payload powering the My Work landing page:
// today's priorities, overdue, blockers, pending updates, recent activity.
func (h *Me) Work(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	type taskOut struct {
		ID, Title, Status, Project string    `json:"-"`
		Priority                    int       `json:"-"`
		DueOn                       *time.Time
	}
	out := gin.H{}

	// counts
	type counts struct {
		ActiveTasks    int `json:"active_tasks"`
		OverdueTasks   int `json:"overdue_tasks"`
		BlockedTasks   int `json:"blocked_tasks"`
		ActiveProjects int `json:"active_projects"`
		PendingUpdates int `json:"pending_updates"`
		HoursThisWeek  float64 `json:"hours_this_week"`
	}
	var ct counts
	_ = h.db.QueryRow(c, `SELECT COUNT(*) FROM tasks t
		JOIN projects p ON p.id=t.project_id
		WHERE p.tenant_id=$1 AND t.assignee_id=$2 AND t.deleted_at IS NULL AND t.status <> 'done'`,
		tid, uid).Scan(&ct.ActiveTasks)
	_ = h.db.QueryRow(c, `SELECT COUNT(*) FROM tasks t
		JOIN projects p ON p.id=t.project_id
		WHERE p.tenant_id=$1 AND t.assignee_id=$2 AND t.deleted_at IS NULL
		      AND t.status <> 'done' AND t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE`,
		tid, uid).Scan(&ct.OverdueTasks)
	_ = h.db.QueryRow(c, `SELECT COUNT(*) FROM tasks t
		JOIN projects p ON p.id=t.project_id
		WHERE p.tenant_id=$1 AND t.assignee_id=$2 AND t.deleted_at IS NULL AND t.status='blocked'`,
		tid, uid).Scan(&ct.BlockedTasks)
	_ = h.db.QueryRow(c, `SELECT COUNT(DISTINCT p.id) FROM project_members pm
		JOIN projects p ON p.id = pm.project_id
		WHERE p.tenant_id=$1 AND pm.user_id=$2 AND pm.removed_at IS NULL
		      AND p.deleted_at IS NULL AND p.status NOT IN ('paid','closed')`,
		tid, uid).Scan(&ct.ActiveProjects)
	_ = h.db.QueryRow(c, `SELECT COALESCE(SUM(hours),0) FROM time_entries
		WHERE user_id=$1 AND work_date >= date_trunc('week', CURRENT_DATE)`,
		uid).Scan(&ct.HoursThisWeek)
	// Days since last daily update (proxy for "pending updates")
	var lastUpdate *time.Time
	_ = h.db.QueryRow(c, `SELECT MAX(for_date) FROM personal_updates
		WHERE tenant_id=$1 AND user_id=$2 AND kind='daily'`, tid, uid).Scan(&lastUpdate)
	if lastUpdate == nil {
		ct.PendingUpdates = 1
	} else {
		days := int(time.Since(*lastUpdate).Hours() / 24)
		if days >= 1 {
			ct.PendingUpdates = days
		}
	}
	out["counts"] = ct

	// Today's priorities — open tasks due today or earlier, sorted by priority then due
	priorities := []gin.H{}
	rows, _ := h.db.Query(c, `
		SELECT t.id, t.title, t.status, t.priority, t.due_on, p.name, p.id
		FROM tasks t JOIN projects p ON p.id=t.project_id
		WHERE p.tenant_id=$1 AND t.assignee_id=$2 AND t.deleted_at IS NULL
		      AND t.status NOT IN ('done')
		ORDER BY (t.due_on IS NULL), t.due_on ASC, t.priority ASC
		LIMIT 8`, tid, uid)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var (
				id, projID uuid.UUID
				title, status, projectName string
				prio int
				due *time.Time
			)
			if err := rows.Scan(&id, &title, &status, &prio, &due, &projectName, &projID); err == nil {
				row := gin.H{
					"id": id, "title": title, "status": status, "priority": prio,
					"project_id": projID, "project_name": projectName,
				}
				if due != nil {
					row["due_on"] = due.Format("2006-01-02")
				}
				priorities = append(priorities, row)
			}
		}
	}
	out["priorities"] = priorities

	// Active projects with role + allocation
	projs := []gin.H{}
	prows, _ := h.db.Query(c, `
		SELECT p.id, p.code, p.name, p.status, p.health, pm.role, pm.allocation
		FROM project_members pm JOIN projects p ON p.id = pm.project_id
		WHERE p.tenant_id=$1 AND pm.user_id=$2 AND pm.removed_at IS NULL
		      AND p.deleted_at IS NULL AND p.status NOT IN ('paid','closed')
		ORDER BY p.updated_at DESC LIMIT 8`, tid, uid)
	if prows != nil {
		defer prows.Close()
		for prows.Next() {
			var (
				pid uuid.UUID
				code, name, status, health, role string
				alloc float64
			)
			if err := prows.Scan(&pid, &code, &name, &status, &health, &role, &alloc); err == nil {
				projs = append(projs, gin.H{
					"id": pid, "code": code, "name": name,
					"status": status, "health": health, "role": role, "allocation": alloc,
				})
			}
		}
	}
	out["projects"] = projs

	c.JSON(http.StatusOK, out)
}

/* ---------- Tasks ---------- */

func (h *Me) Tasks(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	status := c.Query("status")

	q := `
		SELECT t.id, t.title, COALESCE(t.description,''), t.status, t.priority, t.due_on,
		       t.created_at, t.updated_at, p.id, p.code, p.name
		FROM tasks t JOIN projects p ON p.id=t.project_id
		WHERE p.tenant_id=$1 AND t.assignee_id=$2 AND t.deleted_at IS NULL`
	args := []any{tid, uid}
	if status != "" && status != "all" {
		q += " AND t.status=$3"
		args = append(args, status)
	}
	q += " ORDER BY (t.due_on IS NULL), t.due_on ASC, t.priority ASC LIMIT 200"
	rows, err := h.db.Query(c, q, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()}); return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id, projID uuid.UUID
			title, descr, status, code, name string
			prio int
			due *time.Time
			created, updated time.Time
		)
		if err := rows.Scan(&id, &title, &descr, &status, &prio, &due, &created, &updated, &projID, &code, &name); err == nil {
			row := gin.H{
				"id": id, "title": title, "description": descr,
				"status": status, "priority": prio,
				"project_id": projID, "project_code": code, "project_name": name,
				"created_at": created, "updated_at": updated,
			}
			if due != nil {
				row["due_on"] = due.Format("2006-01-02")
			}
			out = append(out, row)
		}
	}
	c.JSON(200, gin.H{"items": out})
}

func (h *Me) UpdateTaskStatus(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(400, gin.H{"error":"bad id"}); return }
	var req struct {
		Status  string `json:"status" binding:"required,oneof=todo in_progress blocked review done"`
		Comment string `json:"comment"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }

	// Verify task belongs to a project in this tenant and is assigned to this user.
	var owner uuid.UUID
	if err := h.db.QueryRow(c, `
		SELECT t.assignee_id FROM tasks t JOIN projects p ON p.id=t.project_id
		WHERE t.id=$1 AND p.tenant_id=$2 AND t.deleted_at IS NULL`, id, tid).Scan(&owner); err != nil {
		c.JSON(404, gin.H{"error":"not found"}); return
	}
	if owner != uid {
		c.JSON(403, gin.H{"error":"this task is not assigned to you"}); return
	}
	if _, err := h.db.Exec(c, `UPDATE tasks SET status=$1, updated_at=now() WHERE id=$2`, req.Status, id); err != nil {
		c.JSON(500, gin.H{"error": err.Error()}); return
	}
	if strings.TrimSpace(req.Comment) != "" {
		_, _ = h.db.Exec(c, `INSERT INTO task_comments (task_id, author_id, body) VALUES ($1,$2,$3)`,
			id, uid, strings.TrimSpace(req.Comment))
	}
	c.JSON(200, gin.H{"ok": true, "status": req.Status})
}

func (h *Me) AddTaskComment(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(400, gin.H{"error":"bad id"}); return }
	var req struct {
		Body string `json:"body" binding:"required,min=1"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }

	// Confirm task is in this tenant and (assigned to me OR I'm a member of the project).
	var assignee *uuid.UUID
	var projID uuid.UUID
	if err := h.db.QueryRow(c, `
		SELECT t.assignee_id, p.id FROM tasks t JOIN projects p ON p.id=t.project_id
		WHERE t.id=$1 AND p.tenant_id=$2 AND t.deleted_at IS NULL`, id, tid).Scan(&assignee, &projID); err != nil {
		c.JSON(404, gin.H{"error":"not found"}); return
	}
	if assignee == nil || *assignee != uid {
		// Allow comments if user is a project member.
		var isMember bool
		_ = h.db.QueryRow(c, `SELECT EXISTS (SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND removed_at IS NULL)`,
			projID, uid).Scan(&isMember)
		if !isMember {
			c.JSON(403, gin.H{"error":"not your task"}); return
		}
	}
	cid := uuid.New()
	if _, err := h.db.Exec(c, `INSERT INTO task_comments (id, task_id, author_id, body) VALUES ($1,$2,$3,$4)`,
		cid, id, uid, strings.TrimSpace(req.Body)); err != nil {
		c.JSON(500, gin.H{"error": err.Error()}); return
	}
	c.JSON(201, gin.H{"id": cid})
}

func (h *Me) TaskComments(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(400, gin.H{"error":"bad id"}); return }

	// Confirm task tenancy + access
	var assignee *uuid.UUID
	var projID uuid.UUID
	if err := h.db.QueryRow(c, `
		SELECT t.assignee_id, p.id FROM tasks t JOIN projects p ON p.id=t.project_id
		WHERE t.id=$1 AND p.tenant_id=$2 AND t.deleted_at IS NULL`, id, tid).Scan(&assignee, &projID); err != nil {
		c.JSON(404, gin.H{"error":"not found"}); return
	}
	if assignee == nil || *assignee != uid {
		var isMember bool
		_ = h.db.QueryRow(c, `SELECT EXISTS (SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND removed_at IS NULL)`,
			projID, uid).Scan(&isMember)
		if !isMember {
			c.JSON(403, gin.H{"error":"not your task"}); return
		}
	}
	rows, _ := h.db.Query(c, `
		SELECT c.id, c.body, c.created_at, COALESCE(u.name, u.email, '')
		FROM task_comments c LEFT JOIN users u ON u.id = c.author_id
		WHERE c.task_id=$1 ORDER BY c.created_at ASC`, id)
	out := []gin.H{}
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var (
				id uuid.UUID
				body, author string
				at time.Time
			)
			if err := rows.Scan(&id, &body, &at, &author); err == nil {
				out = append(out, gin.H{"id": id, "body": body, "created_at": at, "author": author})
			}
		}
	}
	c.JSON(200, gin.H{"items": out})
}

/* ---------- Personal updates ---------- */

func (h *Me) Updates(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, _ := h.db.Query(c, `
		SELECT u.id, u.kind, u.title, u.body, u.for_date, u.created_at, p.name
		FROM personal_updates u
		LEFT JOIN projects p ON p.id = u.project_id
		WHERE u.tenant_id=$1 AND u.user_id=$2
		ORDER BY u.for_date DESC, u.created_at DESC LIMIT 100`, tid, uid)
	out := []gin.H{}
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var (
				id uuid.UUID
				kind, title, body string
				date time.Time
				at time.Time
				project *string
			)
			if err := rows.Scan(&id, &kind, &title, &body, &date, &at, &project); err == nil {
				out = append(out, gin.H{
					"id": id, "kind": kind, "title": title, "body": body,
					"for_date": date.Format("2006-01-02"),
					"created_at": at,
					"project_name": project,
				})
			}
		}
	}
	c.JSON(200, gin.H{"items": out})
}

func (h *Me) AddUpdate(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var req struct {
		Kind      string `json:"kind"      binding:"required,oneof=daily weekly blocker accomplishment next_action risk"`
		Title     string `json:"title"     binding:"required,max=160"`
		Body      string `json:"body"`
		ForDate   string `json:"for_date"`
		ProjectID string `json:"project_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }

	id := uuid.New()
	args := []any{id, tid, uid, req.Kind, strings.TrimSpace(req.Title), req.Body}
	q := `INSERT INTO personal_updates (id, tenant_id, user_id, kind, title, body`
	vals := `$1,$2,$3,$4,$5,$6`
	if strings.TrimSpace(req.ForDate) != "" {
		q += ", for_date"
		vals += ", $" + intStr(len(args)+1)
		args = append(args, req.ForDate)
	}
	if pid, err := uuid.Parse(strings.TrimSpace(req.ProjectID)); err == nil && pid != uuid.Nil {
		// Verify the project belongs to my tenant and I'm a member.
		var ok bool
		_ = h.db.QueryRow(c, `SELECT EXISTS (
			SELECT 1 FROM project_members pm
			JOIN projects p ON p.id = pm.project_id
			WHERE pm.user_id=$1 AND pm.project_id=$2 AND pm.removed_at IS NULL AND p.tenant_id=$3
		)`, uid, pid, tid).Scan(&ok)
		if ok {
			q += ", project_id"
			vals += ", $" + intStr(len(args)+1)
			args = append(args, pid)
		}
	}
	q += ") VALUES (" + vals + ")"
	if _, err := h.db.Exec(c, q, args...); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	c.JSON(201, gin.H{"id": id})
}

/* ---------- Timesheet ---------- */

func (h *Me) Timesheet(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, _ := h.db.Query(c, `
		SELECT te.id, te.work_date, te.hours::float8, COALESCE(te.notes,''),
		       p.id, p.name, t.id, COALESCE(t.title,'')
		FROM time_entries te
		JOIN projects p ON p.id = te.project_id
		LEFT JOIN tasks t ON t.id = te.task_id
		WHERE te.user_id=$1 AND p.tenant_id=$2
		ORDER BY te.work_date DESC, te.created_at DESC LIMIT 200`, uid, tid)
	out := []gin.H{}
	var weekHours, monthHours float64
	if rows != nil {
		defer rows.Close()
		startOfWeek := time.Now().AddDate(0, 0, -int(time.Now().Weekday()))
		startOfMonth := time.Date(time.Now().Year(), time.Now().Month(), 1, 0, 0, 0, 0, time.Now().Location())
		for rows.Next() {
			var (
				id uuid.UUID
				date time.Time
				hours float64
				notes, projectName, taskTitle string
				projID uuid.UUID
				taskID *uuid.UUID
			)
			if err := rows.Scan(&id, &date, &hours, &notes, &projID, &projectName, &taskID, &taskTitle); err == nil {
				row := gin.H{
					"id": id, "work_date": date.Format("2006-01-02"),
					"hours": hours, "notes": notes,
					"project_id": projID, "project_name": projectName,
				}
				if taskID != nil {
					row["task_id"] = *taskID
					row["task_title"] = taskTitle
				}
				out = append(out, row)
				if !date.Before(startOfWeek)  { weekHours  += hours }
				if !date.Before(startOfMonth) { monthHours += hours }
			}
		}
	}
	c.JSON(200, gin.H{
		"items": out,
		"hours_this_week":  weekHours,
		"hours_this_month": monthHours,
	})
}

/* ---------- Files / documents ---------- */

// Files returns the documents visible to the current user — anything attached
// to opportunities they created OR opportunities tied to projects they're a
// member of. The result is grouped to support a per-project drill-down.
func (h *Me) Files(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	rows, err := h.db.Query(c, `
		SELECT d.id, d.kind, d.name, COALESCE(d.object_key,''), d.uploaded_at,
		       o.id, o.title,
		       p.id, p.name
		FROM opportunity_documents d
		JOIN opportunities o ON o.id = d.opportunity_id
		LEFT JOIN projects p ON p.opportunity_id = o.id AND p.deleted_at IS NULL
		WHERE o.tenant_id = $1 AND o.deleted_at IS NULL
		  AND (
		        o.created_by = $2
		     OR EXISTS (
		          SELECT 1 FROM project_members pm
		          WHERE pm.user_id = $2 AND pm.removed_at IS NULL AND pm.project_id = p.id
		        )
		      )
		ORDER BY d.uploaded_at DESC
		LIMIT 200`, tid, uid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()}); return
	}
	defer rows.Close()

	out := []gin.H{}
	for rows.Next() {
		var (
			did                          uuid.UUID
			kind, name, objKey           string
			uploaded                     time.Time
			oid                          uuid.UUID
			oppTitle                     string
			pid                          *uuid.UUID
			projectName                  *string
		)
		if err := rows.Scan(&did, &kind, &name, &objKey, &uploaded, &oid, &oppTitle, &pid, &projectName); err != nil {
			continue
		}
		row := gin.H{
			"id":           did,
			"kind":         kind,
			"name":         name,
			"object_key":   objKey,
			"uploaded_at":  uploaded,
			"opportunity_id":    oid,
			"opportunity_title": oppTitle,
		}
		if pid != nil { row["project_id"] = *pid }
		if projectName != nil { row["project_name"] = *projectName }
		out = append(out, row)
	}
	c.JSON(200, gin.H{"items": out})
}

/* ---------- Profile ---------- */

func (h *Me) Profile(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	roles, _ := c.Get(mw.CtxRoles)
	rs, _ := roles.([]string)

	var (
		email, name, ghUser string
	)
	_ = h.db.QueryRow(c, `SELECT email, COALESCE(full_name,''), COALESCE(github_username,'')
		FROM users WHERE id=$1`, uid).Scan(&email, &name, &ghUser)

	// Activity counters
	type act struct {
		TasksDone, TasksOverdue, BlockedNow, UpdatesLast7 int
		HoursLast30 float64
	}
	var a act
	_ = h.db.QueryRow(c, `SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id=t.project_id
		WHERE p.tenant_id=$1 AND t.assignee_id=$2 AND t.status='done' AND t.deleted_at IS NULL`, tid, uid).Scan(&a.TasksDone)
	_ = h.db.QueryRow(c, `SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id=t.project_id
		WHERE p.tenant_id=$1 AND t.assignee_id=$2 AND t.deleted_at IS NULL
		      AND t.status<>'done' AND t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE`, tid, uid).Scan(&a.TasksOverdue)
	_ = h.db.QueryRow(c, `SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id=t.project_id
		WHERE p.tenant_id=$1 AND t.assignee_id=$2 AND t.deleted_at IS NULL AND t.status='blocked'`, tid, uid).Scan(&a.BlockedNow)
	_ = h.db.QueryRow(c, `SELECT COUNT(*) FROM personal_updates
		WHERE tenant_id=$1 AND user_id=$2 AND for_date >= CURRENT_DATE - 7`, tid, uid).Scan(&a.UpdatesLast7)
	_ = h.db.QueryRow(c, `SELECT COALESCE(SUM(hours),0) FROM time_entries
		WHERE user_id=$1 AND work_date >= CURRENT_DATE - 30`, uid).Scan(&a.HoursLast30)

	c.JSON(200, gin.H{
		"id": uid, "email": email, "name": name,
		"github_username": ghUser,
		"roles": rs,
		"performance": gin.H{
			"tasks_done":     a.TasksDone,
			"tasks_overdue":  a.TasksOverdue,
			"blocked_now":    a.BlockedNow,
			"updates_last_7": a.UpdatesLast7,
			"hours_last_30":  a.HoursLast30,
		},
	})
}

func (h *Me) PutProfile(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Name           *string `json:"name"`
		GithubUsername *string `json:"github_username"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }
	sets := []string{}
	args := []any{}
	add := func(col string, v any) { args = append(args, v); sets = append(sets, col+"=$"+strconv.Itoa(len(args))) }
	if req.Name != nil           { add("full_name", strings.TrimSpace(*req.Name)) }
	if req.GithubUsername != nil { add("github_username", strings.TrimSpace(*req.GithubUsername)) }
	if len(sets) == 0 { c.JSON(400, gin.H{"error":"nothing to update"}); return }
	args = append(args, uid)
	q := "UPDATE users SET " + strings.Join(sets, ", ") + " WHERE id=$" + strconv.Itoa(len(args))
	if _, err := h.db.Exec(c, q, args...); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	c.JSON(200, gin.H{"ok": true})
}

/* ---------- helpers ---------- */

func intStr(n int) string { return strconv.Itoa(n) }
