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
