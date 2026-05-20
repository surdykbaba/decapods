// Learning & development handlers — catalog of external/internal
// resources, ordered paths, and per-user assignments with progress.
// All endpoints are tenant-scoped via middleware. Auth model:
//
//   • Anyone authenticated can browse the catalog and self-assign.
//   • Anyone can add a resource (encourages curation; admins can clean
//     up). Edit/delete on a resource is author-or-admin.
//   • Paths are admin-managed today (governance:write at the route).
//   • Assigning a path/resource to *another* user is allowed only for
//     the report's manager or an admin — same rule as 1-on-1 notes.
package handlers

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/decapods/pgdp/backend/internal/auth"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Learning struct{ db *pgxpool.Pool }

func NewLearning(db *pgxpool.Pool) *Learning { return &Learning{db: db} }

// ──────────────────────────────────────────────────────────────────────────
// Resources

// ListResources — catalog browse. Optional filters: ?topic=, ?role=,
// ?provider=, ?q= (matches title + description). Soft-deleted rows
// excluded. Capped at 200 — UI will paginate when we outgrow that.
func (h *Learning) ListResources(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	args := []any{tid}
	q := `SELECT r.id, r.provider, COALESCE(r.external_id,''), r.external_url,
	             r.title, COALESCE(r.description,''), COALESCE(r.topic,''),
	             r.role_tags, r.difficulty, r.duration_minutes,
	             r.added_by, COALESCE(u.full_name,''), r.created_at
	      FROM learning_resources r
	      LEFT JOIN users u ON u.id = r.added_by
	      WHERE r.tenant_id = $1 AND r.deleted_at IS NULL`
	if topic := strings.TrimSpace(c.Query("topic")); topic != "" {
		args = append(args, topic)
		q += " AND r.topic = $" + strconv.Itoa(len(args))
	}
	if role := strings.TrimSpace(c.Query("role")); role != "" {
		args = append(args, role)
		q += " AND $" + strconv.Itoa(len(args)) + " = ANY(r.role_tags)"
	}
	if provider := strings.TrimSpace(c.Query("provider")); provider != "" {
		args = append(args, provider)
		q += " AND r.provider = $" + strconv.Itoa(len(args))
	}
	if qs := strings.TrimSpace(c.Query("q")); qs != "" {
		args = append(args, "%"+qs+"%")
		n := strconv.Itoa(len(args))
		q += " AND (r.title ILIKE $" + n + " OR r.description ILIKE $" + n + ")"
	}
	q += " ORDER BY r.created_at DESC LIMIT 200"

	rows, err := h.db.Query(c.Request.Context(), q, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	items := []gin.H{}
	for rows.Next() {
		var (
			id                                            uuid.UUID
			provider, extID, extURL, title, desc, topic   string
			roleTags                                      []string
			difficulty                                    string
			duration                                      *int
			addedBy                                       *uuid.UUID
			addedByName                                   string
			created                                       time.Time
		)
		if err := rows.Scan(&id, &provider, &extID, &extURL, &title, &desc, &topic,
			&roleTags, &difficulty, &duration, &addedBy, &addedByName, &created); err == nil {
			items = append(items, gin.H{
				"id": id, "provider": provider, "external_id": extID,
				"external_url": extURL, "title": title, "description": desc,
				"topic": topic, "role_tags": roleTags, "difficulty": difficulty,
				"duration_minutes": duration,
				"added_by": addedBy, "added_by_name": addedByName,
				"created_at": created,
			})
		}
	}
	c.JSON(200, gin.H{"items": items})
}

func (h *Learning) CreateResource(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Provider        string   `json:"provider"`
		ExternalID      string   `json:"external_id"`
		ExternalURL     string   `json:"external_url" binding:"required,min=1"`
		Title           string   `json:"title"        binding:"required,min=1"`
		Description     string   `json:"description"`
		Topic           string   `json:"topic"`
		RoleTags        []string `json:"role_tags"`
		Difficulty      string   `json:"difficulty"`
		DurationMinutes *int     `json:"duration_minutes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	provider := strings.TrimSpace(req.Provider)
	if provider == "" {
		provider = "other"
	}
	difficulty := strings.TrimSpace(req.Difficulty)
	if difficulty == "" {
		difficulty = "all"
	}
	if req.RoleTags == nil {
		req.RoleTags = []string{}
	}
	var id uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		INSERT INTO learning_resources
		  (tenant_id, provider, external_id, external_url, title, description,
		   topic, role_tags, difficulty, duration_minutes, added_by)
		VALUES ($1,$2,NULLIF($3,''),$4,$5,NULLIF($6,''),NULLIF($7,''),$8,$9,$10,$11)
		RETURNING id`,
		tid, provider, strings.TrimSpace(req.ExternalID),
		strings.TrimSpace(req.ExternalURL), strings.TrimSpace(req.Title),
		strings.TrimSpace(req.Description), strings.TrimSpace(req.Topic),
		req.RoleTags, difficulty, req.DurationMinutes, uid,
	).Scan(&id); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

func (h *Learning) UpdateResource(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var addedBy uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(),
		`SELECT added_by FROM learning_resources WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`,
		id, tid,
	).Scan(&addedBy); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "resource not found"})
		return
	}
	if addedBy != uid && !auth.HasPermission(roles, "governance:write") {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the author or an admin can edit"})
		return
	}
	var req struct {
		Title           *string  `json:"title"`
		Description     *string  `json:"description"`
		Topic           *string  `json:"topic"`
		RoleTags        []string `json:"role_tags"`
		Difficulty      *string  `json:"difficulty"`
		DurationMinutes *int     `json:"duration_minutes"`
		ExternalURL     *string  `json:"external_url"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	sets := []string{"updated_at = now()"}
	args := []any{}
	add := func(col string, v any) { args = append(args, v); sets = append(sets, col+"=$"+strconv.Itoa(len(args))) }
	if req.Title != nil {
		add("title", strings.TrimSpace(*req.Title))
	}
	if req.Description != nil {
		add("description", strings.TrimSpace(*req.Description))
	}
	if req.Topic != nil {
		add("topic", strings.TrimSpace(*req.Topic))
	}
	if req.RoleTags != nil {
		add("role_tags", req.RoleTags)
	}
	if req.Difficulty != nil {
		add("difficulty", strings.TrimSpace(*req.Difficulty))
	}
	if req.DurationMinutes != nil {
		add("duration_minutes", *req.DurationMinutes)
	}
	if req.ExternalURL != nil {
		add("external_url", strings.TrimSpace(*req.ExternalURL))
	}
	args = append(args, id, tid)
	sql := "UPDATE learning_resources SET " + strings.Join(sets, ", ") +
		" WHERE id=$" + strconv.Itoa(len(args)-1) +
		" AND tenant_id=$" + strconv.Itoa(len(args))
	if _, err := h.db.Exec(c.Request.Context(), sql, args...); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (h *Learning) DeleteResource(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var addedBy uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(),
		`SELECT added_by FROM learning_resources WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`,
		id, tid,
	).Scan(&addedBy); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "resource not found"})
		return
	}
	if addedBy != uid && !auth.HasPermission(roles, "governance:write") {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the author or an admin can delete"})
		return
	}
	if _, err := h.db.Exec(c.Request.Context(),
		`UPDATE learning_resources SET deleted_at = now() WHERE id=$1 AND tenant_id=$2`,
		id, tid,
	); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// ──────────────────────────────────────────────────────────────────────────
// Paths

func (h *Learning) ListPaths(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT p.id, p.name, COALESCE(p.description,''), COALESCE(p.role,''),
		       p.created_by, COALESCE(u.full_name,''), p.created_at,
		       (SELECT COUNT(*) FROM learning_path_items WHERE path_id = p.id) AS item_count
		FROM learning_paths p
		LEFT JOIN users u ON u.id = p.created_by
		WHERE p.tenant_id = $1 AND p.deleted_at IS NULL
		ORDER BY p.created_at DESC
		LIMIT 200`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	items := []gin.H{}
	for rows.Next() {
		var (
			id                       uuid.UUID
			name, desc, role         string
			createdBy                *uuid.UUID
			createdByName            string
			created                  time.Time
			count                    int64
		)
		if err := rows.Scan(&id, &name, &desc, &role, &createdBy, &createdByName, &created, &count); err == nil {
			items = append(items, gin.H{
				"id": id, "name": name, "description": desc, "role": role,
				"created_by": createdBy, "created_by_name": createdByName,
				"created_at": created, "item_count": count,
			})
		}
	}
	c.JSON(200, gin.H{"items": items})
}

func (h *Learning) GetPath(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var (
		name, desc, role string
		createdAt        time.Time
	)
	if err := h.db.QueryRow(c.Request.Context(),
		`SELECT name, COALESCE(description,''), COALESCE(role,''), created_at
		 FROM learning_paths WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`,
		id, tid,
	).Scan(&name, &desc, &role, &createdAt); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "path not found"})
		return
	}
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT r.id, r.title, COALESCE(r.description,''), r.external_url,
		       r.provider, COALESCE(r.topic,''), r.duration_minutes,
		       i.position, i.required
		FROM learning_path_items i
		JOIN learning_resources r ON r.id = i.resource_id
		WHERE i.path_id = $1 AND r.deleted_at IS NULL
		ORDER BY i.position`, id)
	itemsOut := []gin.H{}
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				rid                    uuid.UUID
				title, desc2, url      string
				provider, topic        string
				duration               *int
				position               int
				required               bool
			)
			if err := rows.Scan(&rid, &title, &desc2, &url, &provider, &topic, &duration, &position, &required); err == nil {
				itemsOut = append(itemsOut, gin.H{
					"resource_id": rid, "title": title, "description": desc2,
					"external_url": url, "provider": provider, "topic": topic,
					"duration_minutes": duration, "position": position, "required": required,
				})
			}
		}
	}
	c.JSON(200, gin.H{
		"id": id, "name": name, "description": desc, "role": role,
		"created_at": createdAt, "items": itemsOut,
	})
}

func (h *Learning) CreatePath(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Name        string `json:"name"        binding:"required,min=1"`
		Description string `json:"description"`
		Role        string `json:"role"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	var id uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		INSERT INTO learning_paths (tenant_id, name, description, role, created_by)
		VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),$5) RETURNING id`,
		tid, strings.TrimSpace(req.Name), strings.TrimSpace(req.Description),
		strings.TrimSpace(req.Role), uid,
	).Scan(&id); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

func (h *Learning) AddPathItem(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	pathID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	// Path must belong to tenant.
	var n int
	if err := h.db.QueryRow(c.Request.Context(),
		`SELECT 1 FROM learning_paths WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`,
		pathID, tid,
	).Scan(&n); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "path not found"})
		return
	}
	var req struct {
		ResourceID string `json:"resource_id" binding:"required"`
		Position   int    `json:"position"`
		Required   *bool  `json:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	resID, err := uuid.Parse(req.ResourceID)
	if err != nil {
		c.JSON(400, gin.H{"error": "bad resource_id"})
		return
	}
	required := true
	if req.Required != nil {
		required = *req.Required
	}
	if _, err := h.db.Exec(c.Request.Context(), `
		INSERT INTO learning_path_items (path_id, resource_id, position, required)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (path_id, resource_id) DO UPDATE
		  SET position = EXCLUDED.position, required = EXCLUDED.required`,
		pathID, resID, req.Position, required,
	); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (h *Learning) RemovePathItem(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	pathID, _ := uuid.Parse(c.Param("id"))
	resID, err := uuid.Parse(c.Param("resourceID"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad resourceID"})
		return
	}
	// Tenant sanity check.
	var n int
	if err := h.db.QueryRow(c.Request.Context(),
		`SELECT 1 FROM learning_paths WHERE id=$1 AND tenant_id=$2`, pathID, tid,
	).Scan(&n); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "path not found"})
		return
	}
	if _, err := h.db.Exec(c.Request.Context(),
		`DELETE FROM learning_path_items WHERE path_id=$1 AND resource_id=$2`,
		pathID, resID,
	); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// ──────────────────────────────────────────────────────────────────────────
// Assignments + progress

// authorizeAssignment — manager-of-target OR governance:write OR
// self-assignment.
func (h *Learning) authorizeAssignment(c *gin.Context, targetID uuid.UUID) bool {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	if uid == targetID {
		return true
	}
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	if auth.HasPermission(roles, "governance:write") || auth.HasPermission(roles, "workforce:write") {
		return true
	}
	var mgrID *uuid.UUID
	if err := h.db.QueryRow(c, `SELECT manager_id FROM users WHERE id=$1 AND tenant_id=$2`, targetID, tid).Scan(&mgrID); err != nil {
		return false
	}
	return mgrID != nil && *mgrID == uid
}

// Assign — manager (or self) starts a course or path. Idempotent:
// returns the existing active assignment if one already exists.
func (h *Learning) Assign(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		UserID     string `json:"user_id"     binding:"required"`
		ResourceID string `json:"resource_id"`
		PathID     string `json:"path_id"`
		DueOn      string `json:"due_on"` // YYYY-MM-DD
		Notes      string `json:"notes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if req.ResourceID == "" && req.PathID == "" {
		c.JSON(400, gin.H{"error": "resource_id or path_id required"})
		return
	}
	if req.ResourceID != "" && req.PathID != "" {
		c.JSON(400, gin.H{"error": "set resource_id OR path_id, not both"})
		return
	}
	targetID, err := uuid.Parse(req.UserID)
	if err != nil {
		c.JSON(400, gin.H{"error": "bad user_id"})
		return
	}
	if !h.authorizeAssignment(c, targetID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the report's manager or an admin can assign"})
		return
	}

	var (
		resID, pathID *uuid.UUID
	)
	if req.ResourceID != "" {
		v, err := uuid.Parse(req.ResourceID)
		if err != nil {
			c.JSON(400, gin.H{"error": "bad resource_id"})
			return
		}
		resID = &v
	}
	if req.PathID != "" {
		v, err := uuid.Parse(req.PathID)
		if err != nil {
			c.JSON(400, gin.H{"error": "bad path_id"})
			return
		}
		pathID = &v
	}
	var due *time.Time
	if s := strings.TrimSpace(req.DueOn); s != "" {
		if t, err := time.Parse("2006-01-02", s); err == nil {
			due = &t
		}
	}

	// Self-assigned rows have assigned_by = NULL so the UI can render
	// "I picked this up" vs "your manager assigned this" differently.
	var assigner *uuid.UUID
	if uid != targetID {
		assigner = &uid
	}

	var id uuid.UUID
	err = h.db.QueryRow(c.Request.Context(), `
		INSERT INTO learning_assignments
		  (tenant_id, user_id, resource_id, path_id, assigned_by, due_on, notes, status)
		VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),'pending')
		ON CONFLICT (user_id, resource_id)
		  WHERE resource_id IS NOT NULL AND status <> 'dropped'
		  DO UPDATE SET due_on = COALESCE(EXCLUDED.due_on, learning_assignments.due_on),
		                notes  = COALESCE(NULLIF(EXCLUDED.notes,''), learning_assignments.notes),
		                updated_at = now()
		RETURNING id`,
		tid, targetID, resID, pathID, assigner, due, strings.TrimSpace(req.Notes),
	).Scan(&id)
	if err != nil {
		// Path conflict has a separate partial unique index — retry that path.
		if pathID != nil && strings.Contains(err.Error(), "uq_learning_assignments_user_path") {
			err = h.db.QueryRow(c.Request.Context(), `
				UPDATE learning_assignments SET due_on = COALESCE($1, due_on),
				  notes = COALESCE(NULLIF($2,''), notes), updated_at = now()
				WHERE user_id=$3 AND path_id=$4 AND status <> 'dropped'
				RETURNING id`,
				due, strings.TrimSpace(req.Notes), targetID, pathID,
			).Scan(&id)
		}
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
	}
	c.JSON(201, gin.H{"id": id})
}

// UpdateAssignment — owner (or assigner / admin) can change status
// (mark in_progress / completed / dropped) and notes.
func (h *Learning) UpdateAssignment(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var (
		userID     uuid.UUID
		assignedBy *uuid.UUID
	)
	if err := h.db.QueryRow(c.Request.Context(),
		`SELECT user_id, assigned_by FROM learning_assignments WHERE id=$1 AND tenant_id=$2`,
		id, tid,
	).Scan(&userID, &assignedBy); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "assignment not found"})
		return
	}
	allowed := userID == uid ||
		(assignedBy != nil && *assignedBy == uid) ||
		auth.HasPermission(roles, "governance:write")
	if !allowed {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the learner, the assigner, or an admin can update"})
		return
	}
	var req struct {
		Status     *string  `json:"status"`
		Notes      *string  `json:"notes"`
		HoursSpent *float64 `json:"hours_spent"`
		DueOn      *string  `json:"due_on"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	sets := []string{"updated_at = now()"}
	args := []any{}
	add := func(col string, v any) { args = append(args, v); sets = append(sets, col+"=$"+strconv.Itoa(len(args))) }
	if req.Status != nil {
		s := strings.TrimSpace(*req.Status)
		valid := map[string]bool{"pending": true, "in_progress": true, "completed": true, "dropped": true}
		if !valid[s] {
			c.JSON(400, gin.H{"error": "invalid status"})
			return
		}
		add("status", s)
		// Stamp started_at on first move to in_progress; stamp
		// completed_at on completion. These are conditional so the
		// caller can correct a misclick (e.g. moving completed → in_progress)
		// without losing history altogether.
		if s == "in_progress" {
			sets = append(sets, "started_at = COALESCE(started_at, now())")
		}
		if s == "completed" {
			sets = append(sets, "completed_at = COALESCE(completed_at, now())")
		}
	}
	if req.Notes != nil {
		add("notes", strings.TrimSpace(*req.Notes))
	}
	if req.HoursSpent != nil {
		add("hours_spent", *req.HoursSpent)
	}
	if req.DueOn != nil {
		s := strings.TrimSpace(*req.DueOn)
		if s == "" {
			add("due_on", nil)
		} else if t, err := time.Parse("2006-01-02", s); err == nil {
			add("due_on", t)
		}
	}
	args = append(args, id, tid)
	sql := "UPDATE learning_assignments SET " + strings.Join(sets, ", ") +
		" WHERE id=$" + strconv.Itoa(len(args)-1) +
		" AND tenant_id=$" + strconv.Itoa(len(args))
	if _, err := h.db.Exec(c.Request.Context(), sql, args...); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// MyLearning — the caller's queue: in-progress + pending first, then
// completed (capped). Joined to resource + path so a single payload
// drives the dashboard widget.
func (h *Learning) MyLearning(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	c.JSON(200, h.listForUser(c, tid, uid))
}

// ReportLearning — manager peeking at a report's progress.
func (h *Learning) ReportLearning(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	targetID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	if !h.authorizeAssignment(c, targetID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "not your report"})
		return
	}
	c.JSON(200, h.listForUser(c, tid, targetID))
}

func (h *Learning) listForUser(c *gin.Context, tid, userID uuid.UUID) gin.H {
	rows, _ := h.db.Query(c.Request.Context(), `
		SELECT a.id, a.status, a.due_on, a.started_at, a.completed_at,
		       a.hours_spent, COALESCE(a.notes,''), a.assigned_by, COALESCE(au.full_name,''),
		       a.resource_id, COALESCE(r.title,''), COALESCE(r.external_url,''),
		       COALESCE(r.provider,''), COALESCE(r.topic,''), r.duration_minutes,
		       a.path_id, COALESCE(p.name,'')
		FROM learning_assignments a
		LEFT JOIN learning_resources r ON r.id = a.resource_id
		LEFT JOIN learning_paths     p ON p.id = a.path_id
		LEFT JOIN users au              ON au.id = a.assigned_by
		WHERE a.tenant_id=$1 AND a.user_id=$2
		ORDER BY
		  CASE a.status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1
		                WHEN 'completed' THEN 2 ELSE 3 END,
		  a.due_on NULLS LAST,
		  a.updated_at DESC
		LIMIT 200`, tid, userID)
	items := []gin.H{}
	stats := struct {
		Pending    int
		InProgress int
		Completed  int
		Dropped    int
	}{}
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var (
				id           uuid.UUID
				status       string
				due          *time.Time
				started      *time.Time
				completed    *time.Time
				hours        *float64
				notes        string
				assignedBy   *uuid.UUID
				assignerName string
				resID        *uuid.UUID
				resTitle     string
				resURL       string
				provider     string
				topic        string
				duration     *int
				pathID       *uuid.UUID
				pathName     string
			)
			if err := rows.Scan(&id, &status, &due, &started, &completed, &hours, &notes,
				&assignedBy, &assignerName, &resID, &resTitle, &resURL, &provider, &topic,
				&duration, &pathID, &pathName); err == nil {
				switch status {
				case "pending":
					stats.Pending++
				case "in_progress":
					stats.InProgress++
				case "completed":
					stats.Completed++
				case "dropped":
					stats.Dropped++
				}
				items = append(items, gin.H{
					"id": id, "status": status, "due_on": due,
					"started_at": started, "completed_at": completed,
					"hours_spent": hours, "notes": notes,
					"assigned_by": assignedBy, "assigned_by_name": assignerName,
					"resource_id": resID, "resource_title": resTitle,
					"resource_url": resURL, "provider": provider, "topic": topic,
					"duration_minutes": duration,
					"path_id": pathID, "path_name": pathName,
				})
			}
		}
	}
	return gin.H{"items": items, "stats": gin.H{
		"pending": stats.Pending, "in_progress": stats.InProgress,
		"completed": stats.Completed, "dropped": stats.Dropped,
	}}
}
