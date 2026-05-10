package handlers

import (
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Governance struct{ db *pgxpool.Pool }

func NewGovernance(db *pgxpool.Pool) *Governance { return &Governance{db: db} }

func (h *Governance) ListPolicies(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c, `SELECT id, code, kind, active, definition, updated_at
		FROM policy_rules WHERE tenant_id=$1 ORDER BY kind, code`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id          uuid.UUID
			code, kind  string
			active      bool
			def         map[string]any
			updated     any
		)
		if err := rows.Scan(&id, &code, &kind, &active, &def, &updated); err == nil {
			out = append(out, gin.H{"id": id, "code": code, "kind": kind, "active": active,
				"definition": def, "updated_at": updated})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

func (h *Governance) UpsertPolicy(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var req struct {
		Code       string         `json:"code" binding:"required"`
		Kind       string         `json:"kind" binding:"required"`
		Active     bool           `json:"active"`
		Definition map[string]any `json:"definition" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	_, err := h.db.Exec(c, `
		INSERT INTO policy_rules (tenant_id, code, kind, active, definition)
		VALUES ($1,$2,$3,$4,$5::jsonb)
		ON CONFLICT (tenant_id, code) DO UPDATE
		SET kind=EXCLUDED.kind, active=EXCLUDED.active, definition=EXCLUDED.definition, updated_at=now()`,
		tid, req.Code, req.Kind, req.Active, req.Definition)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (h *Governance) Audit(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	entity := c.Query("entity")
	id := c.Query("id")
	q := `SELECT id, actor_id, action, entity, entity_id, diff, created_at
	      FROM audit_log WHERE tenant_id=$1`
	args := []any{tid}
	if entity != "" {
		args = append(args, entity)
		q += ` AND entity=$2`
	}
	if id != "" {
		args = append(args, id)
		q += ` AND entity_id=$3`
	}
	q += ` ORDER BY created_at DESC LIMIT 500`
	rows, err := h.db.Query(c, q, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id, actor, eid       uuid.UUID
			action, ent          string
			diff                 map[string]any
			created              any
		)
		if err := rows.Scan(&id, &actor, &action, &ent, &eid, &diff, &created); err == nil {
			out = append(out, gin.H{
				"id": id, "actor_id": actor, "action": action,
				"entity": ent, "entity_id": eid, "diff": diff, "created_at": created,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}
