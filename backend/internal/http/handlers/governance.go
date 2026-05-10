package handlers

import (
	"strconv"

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

func (h *Governance) DeletePolicy(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	tag, err := h.db.Exec(c, `DELETE FROM policy_rules WHERE id=$1 AND tenant_id=$2`, id, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "policy not found"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// Audit returns the tenant's audit log, newest first. Joined against users so
// the frontend can show a human actor name (and email) without a second round
// trip. Optional filters: ?entity=<kind>, ?id=<entity_id>, ?q=<substring on
// action>. Actor is nullable (system / public actions write NULL).
func (h *Governance) Audit(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	args := []any{tid}
	q := `
		SELECT a.id, a.actor_id, COALESCE(u.full_name,''), COALESCE(u.email::text,''),
		       a.action, a.entity, a.entity_id, a.diff, a.created_at
		FROM audit_log a
		LEFT JOIN users u ON u.id = a.actor_id
		WHERE a.tenant_id=$1`
	if entity := c.Query("entity"); entity != "" {
		args = append(args, entity)
		q += " AND a.entity=$" + strconv.Itoa(len(args))
	}
	if id := c.Query("id"); id != "" {
		args = append(args, id)
		q += " AND a.entity_id=$" + strconv.Itoa(len(args))
	}
	if needle := c.Query("q"); needle != "" {
		args = append(args, "%"+needle+"%")
		n := strconv.Itoa(len(args))
		q += " AND (a.action ILIKE $" + n + " OR u.full_name ILIKE $" + n + " OR u.email::text ILIKE $" + n + ")"
	}
	q += " ORDER BY a.created_at DESC LIMIT 500"

	rows, err := h.db.Query(c, q, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id, eid                       uuid.UUID
			actor                         *uuid.UUID
			actorName, actorEmail, action string
			ent                           string
			diff                          map[string]any
			created                       any
		)
		if err := rows.Scan(&id, &actor, &actorName, &actorEmail, &action, &ent, &eid, &diff, &created); err == nil {
			out = append(out, gin.H{
				"id":          id,
				"actor_id":    actor,
				"actor_name":  actorName,
				"actor_email": actorEmail,
				"action":      action,
				"entity":      ent,
				"entity_id":   eid,
				"diff":        diff,
				"created_at":  created,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}
