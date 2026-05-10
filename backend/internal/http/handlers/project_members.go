package handlers

import (
	"errors"
	"net/http"
	"strings"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ProjectMembers struct {
	db *pgxpool.Pool
}

func NewProjectMembers(db *pgxpool.Pool) *ProjectMembers { return &ProjectMembers{db: db} }

// List — GET /api/v1/projects/:id/members
// Returns the active (not-removed) members of the project, joined onto the
// users table so the caller gets the names/emails/roles needed to render an
// avatar list without a second hop.
func (h *ProjectMembers) List(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	pid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	// Guard: project must belong to this tenant.
	if !h.projectInTenant(c, pid, tid) {
		c.JSON(http.StatusNotFound, gin.H{"error": "project not found"})
		return
	}
	rows, err := h.db.Query(c, `
		SELECT pm.id, pm.user_id, pm.role, pm.allocation::float8, pm.added_at,
		       u.email::text, COALESCE(u.full_name, ''),
		       COALESCE(ARRAY_AGG(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS user_roles
		  FROM project_members pm
		  JOIN users u ON u.id = pm.user_id
		  LEFT JOIN user_roles ur ON ur.user_id = u.id
		  LEFT JOIN roles r ON r.id = ur.role_id
		 WHERE pm.project_id=$1 AND pm.removed_at IS NULL AND u.deleted_at IS NULL
		 GROUP BY pm.id, u.id
		 ORDER BY pm.added_at ASC`, pid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id, userID uuid.UUID
			role       string
			alloc      float64
			added      any
			email, name string
			userRoles  []string
		)
		if err := rows.Scan(&id, &userID, &role, &alloc, &added, &email, &name, &userRoles); err == nil {
			out = append(out, gin.H{
				"id": id, "user_id": userID, "role": role, "allocation": alloc, "added_at": added,
				"email": email, "name": name, "user_roles": userRoles,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// Add — POST /api/v1/projects/:id/members  body: {user_id, role, allocation?}
// Re-activates a soft-removed assignment for the same (user, role) instead of
// erroring on the UNIQUE constraint.
func (h *ProjectMembers) Add(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	pid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	if !h.projectInTenant(c, pid, tid) {
		c.JSON(http.StatusNotFound, gin.H{"error": "project not found"})
		return
	}
	var req struct {
		UserID     string  `json:"user_id" binding:"required,uuid"`
		Role       string  `json:"role"    binding:"required,min=1"`
		Allocation float64 `json:"allocation"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	req.Role = strings.TrimSpace(req.Role)
	if req.Allocation == 0 { req.Allocation = 1.0 }
	if req.Allocation < 0 || req.Allocation > 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "allocation must be between 0 and 1"})
		return
	}
	userID, err := uuid.Parse(req.UserID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad user_id"})
		return
	}
	// User must be a non-deleted member of this tenant.
	var ok bool
	if err := h.db.QueryRow(c,
		`SELECT EXISTS (SELECT 1 FROM users WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL)`,
		userID, tid).Scan(&ok); err != nil || !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "user is not a member of this workspace"})
		return
	}

	// Try insert first; on unique conflict (existing row, possibly removed),
	// re-activate it. This keeps the audit trail intact (same row, new added_at).
	var id uuid.UUID
	err = h.db.QueryRow(c, `
		INSERT INTO project_members (project_id, user_id, role, allocation)
		VALUES ($1,$2,$3,$4) RETURNING id`,
		pid, userID, req.Role, req.Allocation).Scan(&id)
	if err != nil {
		// Likely (project_id, user_id, role) collision. Refresh the existing row.
		uErr := h.db.QueryRow(c, `
			UPDATE project_members
			   SET removed_at = NULL, added_at = now(), allocation = $4
			 WHERE project_id=$1 AND user_id=$2 AND role=$3
			 RETURNING id`, pid, userID, req.Role, req.Allocation).Scan(&id)
		if errors.Is(uErr, pgx.ErrNoRows) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if uErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": uErr.Error()})
			return
		}
	}
	c.JSON(http.StatusCreated, gin.H{"id": id, "user_id": userID, "role": req.Role, "allocation": req.Allocation})
}

// Remove — DELETE /api/v1/projects/:id/members/:memberId
// Soft-removes by setting removed_at, preserving history.
func (h *ProjectMembers) Remove(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	pid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	if !h.projectInTenant(c, pid, tid) {
		c.JSON(http.StatusNotFound, gin.H{"error": "project not found"})
		return
	}
	memberID, err := uuid.Parse(c.Param("memberId"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad memberId"})
		return
	}
	tag, err := h.db.Exec(c, `
		UPDATE project_members SET removed_at = now()
		 WHERE id=$1 AND project_id=$2 AND removed_at IS NULL`, memberID, pid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "member not found on project"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Assignable — GET /api/v1/projects/:id/members/assignable?q=
// Returns workspace members not currently on the project (filtered by an
// optional name/email search). Useful for the "add engineer" picker.
func (h *ProjectMembers) Assignable(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	pid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	if !h.projectInTenant(c, pid, tid) {
		c.JSON(http.StatusNotFound, gin.H{"error": "project not found"})
		return
	}
	q := "%" + strings.TrimSpace(c.Query("q")) + "%"
	rows, err := h.db.Query(c, `
		SELECT u.id, u.email::text, COALESCE(u.full_name,''),
		       COALESCE(ARRAY_AGG(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
		  FROM users u
		  LEFT JOIN user_roles ur ON ur.user_id = u.id
		  LEFT JOIN roles r ON r.id = ur.role_id
		 WHERE u.tenant_id = $1
		   AND u.deleted_at IS NULL
		   AND u.status <> 'disabled'
		   AND u.id NOT IN (
		     SELECT user_id FROM project_members
		      WHERE project_id = $2 AND removed_at IS NULL
		   )
		   AND ($3 = '%%' OR u.full_name ILIKE $3 OR u.email::text ILIKE $3)
		 GROUP BY u.id
		 ORDER BY u.full_name NULLS LAST, u.email
		 LIMIT 50`, tid, pid, q)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id          uuid.UUID
			email, name string
			roles       []string
		)
		if err := rows.Scan(&id, &email, &name, &roles); err == nil {
			out = append(out, gin.H{"id": id, "email": email, "name": name, "roles": roles})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

func (h *ProjectMembers) projectInTenant(c *gin.Context, pid, tid uuid.UUID) bool {
	var ok bool
	if err := h.db.QueryRow(c,
		`SELECT EXISTS (SELECT 1 FROM projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL)`,
		pid, tid).Scan(&ok); err != nil {
		return false
	}
	return ok
}
