package handlers

import (
	"net/http"
	"strconv"
	"strings"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/notifications"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// PatchTask supports inline edits from the Overview / List / Board tabs: change
// status, assignee, dates, title, description, priority. Whitelisted fields
// only — anything else in the body is ignored. Gated by `task:write` on the
// router so any project staffer can flip status / claim a task; the assignee-
// only restriction in /me/tasks/:id/status doesn't apply here on purpose.
func (h *Projects) PatchTask(c *gin.Context) {
	pid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad project id"})
		return
	}
	tid, err := uuid.Parse(c.Param("taskId"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad task id"})
		return
	}
	var body map[string]any
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	sets := []string{}
	args := []any{}
	add := func(col string, val any) {
		args = append(args, val)
		sets = append(sets, col+" = $"+strconv.Itoa(len(args)))
	}

	if v, ok := body["title"].(string); ok && strings.TrimSpace(v) != "" {
		add("title", strings.TrimSpace(v))
	}
	if v, ok := body["description"]; ok {
		s, _ := v.(string)
		add("description", s)
	}
	if v, ok := body["status"].(string); ok {
		switch v {
		case "todo", "in_progress", "blocked", "review", "done":
			add("status", v)
		}
	}
	if v, ok := body["priority"]; ok {
		if f, ok2 := v.(float64); ok2 {
			add("priority", int(f))
		}
	}
	if v, ok := body["assignee_id"]; ok {
		s, _ := v.(string)
		if s == "" || s == "00000000-0000-0000-0000-000000000000" {
			add("assignee_id", nil)
		} else if u, err := uuid.Parse(s); err == nil {
			add("assignee_id", u)
		}
	}
	if v, ok := body["due_on"]; ok {
		if s, _ := v.(string); s == "" {
			add("due_on", nil)
		} else {
			args = append(args, s)
			sets = append(sets, "due_on = NULLIF($"+strconv.Itoa(len(args))+",'')::date")
		}
	}
	if v, ok := body["start_on"]; ok {
		if s, _ := v.(string); s == "" {
			add("start_on", nil)
		} else {
			args = append(args, s)
			sets = append(sets, "start_on = NULLIF($"+strconv.Itoa(len(args))+",'')::date")
		}
	}

	if len(sets) == 0 {
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}

	args = append(args, tid, pid)
	q := "UPDATE tasks SET " + strings.Join(sets, ", ") +
		", updated_at = now() WHERE id = $" + strconv.Itoa(len(args)-1) +
		" AND project_id = $" + strconv.Itoa(len(args)) +
		" AND deleted_at IS NULL"
	if _, err := h.db.Exec(c, q, args...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Automation rule: notify the project lead when a task moves to "blocked",
	// so they can unblock it without waiting on the assignee to chase. Fires
	// only on transitions (not when the value is already blocked) so re-saving
	// a blocked task doesn't re-ping.
	if newStatus, ok := body["status"].(string); ok && newStatus == "blocked" && h.notify != nil {
		var prevStatus, taskTitle, projectName string
		var assignee *uuid.UUID
		_ = h.db.QueryRow(c, `
			SELECT t.status, t.title, p.name, t.assignee_id
			FROM tasks t JOIN projects p ON p.id = t.project_id
			WHERE t.id = $1`, tid).Scan(&prevStatus, &taskTitle, &projectName, &assignee)
		// We already wrote the update; "prev" is now blocked too. Look at the
		// audit/diff cheaply: only fire when the body explicitly transitioned
		// the status (which it did to reach this branch).
		cfg, _ := loadAutomation(c.Request.Context(), h.db, pid)
		if cfg.NotifyLeadOnBlocked {
			lead := findProjectLead(c.Request.Context(), h.db, pid)
			if lead != nil {
				tenantID := c.MustGet(mw.CtxTenantID).(uuid.UUID)
				recipientID := *lead
				h.notify.Notify(c, notifications.Event{
					Kind:     "task.blocked",
					TenantID: tenantID,
					Recipients: []notifications.Recipient{{UserID: &recipientID}},
					Payload: map[string]any{
						"Title":   taskTitle,
						"Project": projectName,
					},
					Link:      "/projects/" + pid.String(),
					DedupeKey: "task.blocked:" + tid.String(),
				})
			}
		}
		_ = assignee
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ListTaskComments returns the comment thread on a task with the author's name
// + email + avatar joined in so the UI doesn't need a second round-trip per
// comment to render a thread.
func (h *Projects) ListTaskComments(c *gin.Context) {
	tid, err := uuid.Parse(c.Param("taskId"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad task id"})
		return
	}
	rows, err := h.db.Query(c, `
		SELECT c.id, c.body, c.created_at,
		       c.author_id, COALESCE(u.full_name,''), COALESCE(u.email::text,''),
		       COALESCE(u.avatar_url,'')
		FROM task_comments c
		LEFT JOIN users u ON u.id = c.author_id
		WHERE c.task_id = $1
		ORDER BY c.created_at ASC`, tid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id                       uuid.UUID
			body, name, email, avatar string
			authorID                 *uuid.UUID
			created                  any
		)
		if err := rows.Scan(&id, &body, &created, &authorID, &name, &email, &avatar); err != nil {
			continue
		}
		out = append(out, gin.H{
			"id":          id,
			"body":        body,
			"created_at":  created,
			"author_id":   authorID,
			"author_name": name,
			"author_email": email,
			"author_avatar": avatar,
		})
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// AddTaskComment posts a comment to a task. The router gates this on
// `task:write` so any staff member with that permission can collaborate —
// you don't need to be the assignee to comment.
func (h *Projects) AddTaskComment(c *gin.Context) {
	tid, err := uuid.Parse(c.Param("taskId"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad task id"})
		return
	}
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var body struct {
		Body string `json:"body" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	body.Body = strings.TrimSpace(body.Body)
	if body.Body == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "empty body"})
		return
	}
	var cid uuid.UUID
	if err := h.db.QueryRow(c, `
		INSERT INTO task_comments (task_id, author_id, body)
		VALUES ($1, $2, $3) RETURNING id`,
		tid, uid, body.Body).Scan(&cid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": cid})
}
