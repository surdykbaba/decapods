package handlers

import (
	"net/http"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Stakeholders struct {
	db *pgxpool.Pool
}

func NewStakeholders(db *pgxpool.Pool) *Stakeholders { return &Stakeholders{db: db} }

func (h *Stakeholders) ListOpportunity(c *gin.Context) { h.list(c, "opportunity") }
func (h *Stakeholders) ListProject(c *gin.Context)     { h.list(c, "project") }
func (h *Stakeholders) AddOpportunity(c *gin.Context)  { h.add(c, "opportunity") }
func (h *Stakeholders) AddProject(c *gin.Context)      { h.add(c, "project") }

func (h *Stakeholders) list(c *gin.Context, entityType string) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	entityID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	rows, err := h.db.Query(c, `
		SELECT id, name, role, kind, COALESCE(email,''), COALESCE(phone,''), COALESCE(notes,''), created_at
		FROM stakeholders
		WHERE tenant_id=$1 AND entity_type=$2 AND entity_id=$3
		ORDER BY kind, name`, tid, entityType, entityID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id                                  uuid.UUID
			name, role, kind, email, phone, notes string
			created                             any
		)
		if err := rows.Scan(&id, &name, &role, &kind, &email, &phone, &notes, &created); err == nil {
			out = append(out, gin.H{
				"id": id, "name": name, "role": role, "kind": kind,
				"email": email, "phone": phone, "notes": notes, "created_at": created,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

type stakeholderReq struct {
	Name  string `json:"name"  binding:"required"`
	Role  string `json:"role"  binding:"required"`
	Kind  string `json:"kind"  binding:"required,oneof=internal external"`
	Email string `json:"email"`
	Phone string `json:"phone"`
	Notes string `json:"notes"`
}

func (h *Stakeholders) add(c *gin.Context, entityType string) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	entityID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req stakeholderReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	id := uuid.New()
	_, err = h.db.Exec(c, `
		INSERT INTO stakeholders (id, tenant_id, entity_type, entity_id, name, role, kind, email, phone, notes, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),NULLIF($9,''),NULLIF($10,''),$11)`,
		id, tid, entityType, entityID, req.Name, req.Role, req.Kind, req.Email, req.Phone, req.Notes, uid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

// ListAll is the tenant-wide directory. Joins each stakeholder to the parent
// entity (opportunity title or project name + code) so the UI doesn't need a
// second round-trip per row.
func (h *Stakeholders) ListAll(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	args := []any{tid}
	q := `
		SELECT s.id, s.name, s.role, s.kind, COALESCE(s.email,''), COALESCE(s.phone,''),
		       COALESCE(s.notes,''), s.created_at, s.entity_type, s.entity_id,
		       COALESCE(
		         CASE s.entity_type
		           WHEN 'opportunity' THEN (SELECT title FROM opportunities WHERE id=s.entity_id AND deleted_at IS NULL)
		           WHEN 'project'     THEN (SELECT name  FROM projects      WHERE id=s.entity_id AND deleted_at IS NULL)
		         END, '(removed)') AS entity_name,
		       COALESCE(
		         CASE s.entity_type
		           WHEN 'project' THEN (SELECT code FROM projects WHERE id=s.entity_id AND deleted_at IS NULL)
		         END, '') AS entity_code
		FROM stakeholders s
		WHERE s.tenant_id = $1`
	if k := c.Query("kind"); k == "internal" || k == "external" {
		args = append(args, k)
		q += " AND s.kind = $2"
	}
	if et := c.Query("entity_type"); et == "opportunity" || et == "project" {
		args = append(args, et)
		q += " AND s.entity_type = $" + intStr(len(args))
	}
	if needle := c.Query("q"); needle != "" {
		args = append(args, "%"+needle+"%")
		q += " AND (s.name ILIKE $" + intStr(len(args)) +
			" OR COALESCE(s.email,'') ILIKE $" + intStr(len(args)) +
			" OR s.role ILIKE $" + intStr(len(args)) + ")"
	}
	q += " ORDER BY s.created_at DESC LIMIT 500"
	rows, err := h.db.Query(c, q, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id, entityID                                                     uuid.UUID
			name, role, kind, email, phone, notes, eType, eName, eCode string
			created                                                          any
		)
		if err := rows.Scan(&id, &name, &role, &kind, &email, &phone, &notes, &created,
			&eType, &entityID, &eName, &eCode); err == nil {
			out = append(out, gin.H{
				"id": id, "name": name, "role": role, "kind": kind,
				"email": email, "phone": phone, "notes": notes,
				"created_at":  created,
				"entity_type": eType,
				"entity_id":   entityID,
				"entity_name": eName,
				"entity_code": eCode,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

// Update PATCHes a single stakeholder. Tenant-scoped, never crosses tenants.
func (h *Stakeholders) Update(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct {
		Name  *string `json:"name"`
		Role  *string `json:"role"`
		Kind  *string `json:"kind"`
		Email *string `json:"email"`
		Phone *string `json:"phone"`
		Notes *string `json:"notes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	sets := []string{}
	args := []any{}
	add := func(col string, v any) { args = append(args, v); sets = append(sets, col+"=$"+intStr(len(args))) }
	if req.Name != nil { add("name", *req.Name) }
	if req.Role != nil { add("role", *req.Role) }
	if req.Kind != nil {
		if *req.Kind != "internal" && *req.Kind != "external" {
			c.JSON(400, gin.H{"error": "invalid kind"})
			return
		}
		add("kind", *req.Kind)
	}
	if req.Email != nil { add("email", *req.Email) }
	if req.Phone != nil { add("phone", *req.Phone) }
	if req.Notes != nil { add("notes", *req.Notes) }
	if len(args) == 0 {
		c.JSON(400, gin.H{"error": "no changes"})
		return
	}
	args = append(args, id, tid)
	q := "UPDATE stakeholders SET "
	for i, s := range sets {
		if i > 0 { q += ", " }
		q += s
	}
	q += " WHERE id=$" + intStr(len(args)-1) + " AND tenant_id=$" + intStr(len(args))
	if _, err := h.db.Exec(c, q, args...); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (h *Stakeholders) Delete(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	if _, err := h.db.Exec(c, `DELETE FROM stakeholders WHERE id=$1 AND tenant_id=$2`, id, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}
