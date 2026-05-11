package handlers

import (
	"net/http"
	"time"

	"github.com/decapods/pgdp/backend/internal/auth"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/notifications"
	"github.com/decapods/pgdp/backend/internal/projects"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Projects struct {
	db     *pgxpool.Pool
	svc    *projects.Service
	notify *notifications.Engine
}

func NewProjects(db *pgxpool.Pool) *Projects {
	return &Projects{db: db, svc: projects.NewService(db)}
}

// WithEngine attaches the notification engine. Optional.
func (h *Projects) WithEngine(engine *notifications.Engine) *Projects {
	h.notify = engine
	return h
}

func (h *Projects) List(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	items, err := h.svc.List(c, tid, c.Query("status"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"items": items})
}

func (h *Projects) Create(c *gin.Context) {
	var req projects.CreateInput
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	req.TenantID = c.MustGet(mw.CtxTenantID).(uuid.UUID)
	req.CreatedBy = c.MustGet(mw.CtxUserID).(uuid.UUID)
	id, err := h.svc.Create(c, req)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

func (h *Projects) Get(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	p, err := h.svc.Get(c, id)
	if err != nil {
		c.JSON(404, gin.H{"error": "not found"})
		return
	}
	c.JSON(200, p)
}

func (h *Projects) Board(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	board, err := h.svc.Board(c, id)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, board)
}

func (h *Projects) AddMilestone(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	var req projects.MilestoneInput
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	// Block assignment to someone on approved leave today — same rule the
	// task creation path enforces.
	if req.AssigneeID != uuid.Nil {
		var onLeave bool
		_ = h.db.QueryRow(c, `
			SELECT EXISTS (
			  SELECT 1 FROM leave_requests
			   WHERE user_id=$1 AND status='approved'
			     AND CURRENT_DATE BETWEEN start_date AND end_date
			)`, req.AssigneeID).Scan(&onLeave)
		if onLeave {
			c.JSON(409, gin.H{
				"error": "Assignee is on approved leave today — pick someone else.",
				"code":  "assignee_on_leave",
			})
			return
		}
	}

	mid, err := h.svc.AddMilestone(c, id, req)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Ping the assignee that they've been handed something. We reuse the
	// catalog's milestone.created event so it lights up both the in-app bell
	// and the email pipeline. Best-effort; never blocks the response.
	if h.notify != nil && req.AssigneeID != uuid.Nil {
		tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
		var projectName string
		_ = h.db.QueryRow(c.Request.Context(),
			`SELECT name FROM projects WHERE id=$1`, id).Scan(&projectName)
		h.notify.Notify(c.Request.Context(), notifications.Event{
			Kind:     "milestone.created",
			TenantID: tid,
			Recipients: []notifications.Recipient{{UserID: &req.AssigneeID}},
			Payload: map[string]any{
				"Project": projectName,
				"Title":   req.Title,
				"DueOn":   req.DueOn,
			},
			DedupeKey: "milestone.created:" + mid.String(),
			Link:      "/projects/" + id.String(),
		})
	}

	c.JSON(201, gin.H{"id": mid})
}

func (h *Projects) AddTask(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	var req projects.TaskInput
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	req.CreatedBy = c.MustGet(mw.CtxUserID).(uuid.UUID)

	// Refuse to assign a task to someone on approved leave today. The
	// frontend already filters them out of the picker; this is defence in
	// depth for direct-API callers.
	if req.AssigneeID != uuid.Nil {
		var onLeave bool
		_ = h.db.QueryRow(c, `
			SELECT EXISTS (
			  SELECT 1 FROM leave_requests
			   WHERE user_id=$1 AND status='approved'
			     AND CURRENT_DATE BETWEEN start_date AND end_date
			)`, req.AssigneeID).Scan(&onLeave)
		if onLeave {
			c.JSON(409, gin.H{
				"error": "Assignee is on approved leave today — pick someone else or wait until they return.",
				"code":  "assignee_on_leave",
			})
			return
		}
	}

	tid, err := h.svc.AddTask(c, id, req)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Email the assignee if they're someone other than the creator. Don't ping
	// people for tasks they made for themselves.
	if h.notify != nil && req.AssigneeID != uuid.Nil && req.AssigneeID != req.CreatedBy {
		tenantID := c.MustGet(mw.CtxTenantID).(uuid.UUID)
		var projectName string
		_ = h.db.QueryRow(c, `SELECT name FROM projects WHERE id=$1`, id).Scan(&projectName)
		assignee := req.AssigneeID
		h.notify.Notify(c, notifications.Event{
			Kind:       "task.assigned",
			TenantID:   tenantID,
			Recipients: []notifications.Recipient{{UserID: &assignee}},
			Payload: map[string]any{
				"Title":   req.Title,
				"Project": projectName,
				"DueOn":   req.DueOn,
			},
			Link:      "/my-work",
			DedupeKey: "task.assigned:" + tid.String(),
		})
	}

	c.JSON(201, gin.H{"id": tid})
}

// AppendLog adds an entry to the project's metadata.{kind} array. Used for
// risks, reports, and the audit_log timeline. Stamps id, at, by automatically.
func (h *Projects) AppendLog(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	kind := c.Param("kind")
	switch kind {
	case "risks", "reports", "audit_log":
	default:
		c.JSON(400, gin.H{"error": "unknown log kind"})
		return
	}
	var body map[string]any
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if body == nil {
		body = map[string]any{}
	}
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	body["id"] = uuid.New().String()
	body["by"] = uid
	body["at"] = time.Now().UTC().Format(time.RFC3339)
	if err := h.svc.AppendLog(c, id, kind, body); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": body["id"]})
}

// PatchLog patches a single item by id within a project's metadata.{kind}.
func (h *Projects) PatchLog(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	kind := c.Param("kind")
	itemID := c.Param("itemId")
	var patch map[string]any
	if err := c.ShouldBindJSON(&patch); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if err := h.svc.PatchLogItem(c, id, kind, itemID, patch); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// SetCheckpoints replaces metadata.checkpoints with a flat key→bool map.
func (h *Projects) SetCheckpoints(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	var req map[string]bool
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if err := h.svc.SetMetaKey(c, id, "checkpoints", req); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (h *Projects) UpdateLinks(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	var req struct {
		Links []map[string]any `json:"links"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if err := h.svc.UpdateLinks(c, id, req.Links); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// Archive soft-deletes a project.
func (h *Projects) Archive(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	if err := h.svc.Archive(c, id, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// ListArchived returns archived projects. Super-admin only.
func (h *Projects) ListArchived(c *gin.Context) {
	roles, _ := c.Get(mw.CtxRoles)
	rs, _ := roles.([]string)
	if !hasRole(rs, "super_admin") {
		c.JSON(403, gin.H{"error": "super_admin only"})
		return
	}
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	items, err := h.svc.ListArchived(c, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"items": items})
}

// Restore brings a soft-deleted project back. Requires super_admin role and
// the user re-entering their password to confirm.
func (h *Projects) Restore(c *gin.Context) {
	roles, _ := c.Get(mw.CtxRoles)
	rs, _ := roles.([]string)
	if !hasRole(rs, "super_admin") {
		c.JSON(403, gin.H{"error": "super_admin only"})
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct {
		Password string `json:"password" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var hash string
	if err := h.db.QueryRow(c, `SELECT password_hash FROM users WHERE id=$1`, uid).Scan(&hash); err != nil {
		c.JSON(401, gin.H{"error": "auth check failed"})
		return
	}
	if err := auth.VerifyPassword(req.Password, hash); err != nil {
		c.JSON(401, gin.H{"error": "wrong password"})
		return
	}
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	if err := h.svc.Restore(c, id, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func hasRole(have []string, role string) bool {
	for _, r := range have {
		if r == role {
			return true
		}
	}
	return false
}

func (h *Projects) RecalculateRisk(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	score, err := h.svc.RecalculateRisk(c, id)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"risk_score": score})
}
