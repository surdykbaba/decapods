package handlers

import (
	"net/http"
	"strconv"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SystemAudit serves the super_admin-only system trail. Where the regular
// /audit endpoint is scoped to one entity for a project's activity tab, this
// returns every action across the workspace with the full request context
// (IP, user agent, method, path) so an operator can answer "who logged in,
// what did they do, from where."
type SystemAudit struct {
	db *pgxpool.Pool
}

func NewSystemAudit(db *pgxpool.Pool) *SystemAudit { return &SystemAudit{db: db} }

// List returns the global audit feed for this tenant with the rich HTTP
// context columns, filterable by actor, action substring, entity, IP, and
// date range. Hard-gated to super_admin — any other role gets 403 even if
// they technically have audit:read.
func (h *SystemAudit) List(c *gin.Context) {
	rolesRaw, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesRaw.([]string)
	if !hasRole(roles, "super_admin") {
		c.JSON(http.StatusForbidden, gin.H{"error": "super_admin only"})
		return
	}
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	args := []any{tid}
	q := `
		SELECT a.id, a.actor_id,
		       COALESCE(u.full_name,''), COALESCE(u.email::text,''),
		       a.action, a.entity, a.entity_id, a.diff,
		       COALESCE(a.ip,''), COALESCE(a.user_agent,''),
		       COALESCE(a.request_method,''), COALESCE(a.request_path,''),
		       a.created_at
		FROM audit_log a
		LEFT JOIN users u ON u.id = a.actor_id
		WHERE a.tenant_id=$1`

	if v := c.Query("actor"); v != "" {
		args = append(args, "%"+v+"%")
		n := strconv.Itoa(len(args))
		q += " AND (u.full_name ILIKE $" + n + " OR u.email::text ILIKE $" + n + ")"
	}
	if v := c.Query("action"); v != "" {
		args = append(args, "%"+v+"%")
		q += " AND a.action ILIKE $" + strconv.Itoa(len(args))
	}
	if v := c.Query("entity"); v != "" {
		args = append(args, v)
		q += " AND a.entity = $" + strconv.Itoa(len(args))
	}
	if v := c.Query("ip"); v != "" {
		args = append(args, "%"+v+"%")
		q += " AND a.ip ILIKE $" + strconv.Itoa(len(args))
	}
	if v := c.Query("since"); v != "" {
		args = append(args, v)
		q += " AND a.created_at >= $" + strconv.Itoa(len(args))
	}
	if v := c.Query("until"); v != "" {
		args = append(args, v)
		q += " AND a.created_at <= $" + strconv.Itoa(len(args))
	}

	limit := 200
	if v := c.Query("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	args = append(args, limit)
	q += " ORDER BY a.created_at DESC LIMIT $" + strconv.Itoa(len(args))

	rows, err := h.db.Query(c, q, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	out := []gin.H{}
	for rows.Next() {
		var (
			id, eid                                    uuid.UUID
			actor                                      *uuid.UUID
			actorName, actorEmail, action, entity      string
			ip, ua, method, path                       string
			diff                                       map[string]any
			created                                    any
		)
		if err := rows.Scan(&id, &actor, &actorName, &actorEmail,
			&action, &entity, &eid, &diff,
			&ip, &ua, &method, &path, &created); err != nil {
			continue
		}
		out = append(out, gin.H{
			"id":             id,
			"actor_id":       actor,
			"actor_name":     actorName,
			"actor_email":    actorEmail,
			"action":         action,
			"entity":         entity,
			"entity_id":      eid,
			"diff":           diff,
			"ip":             ip,
			"user_agent":     ua,
			"request_method": method,
			"request_path":   path,
			"created_at":     created,
		})
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

