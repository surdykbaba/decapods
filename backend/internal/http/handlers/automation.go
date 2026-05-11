package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AutomationConfig is what the frontend sees and writes back. New rules added
// over time should default to false so existing projects don't suddenly start
// enforcing something the operator never opted into.
type AutomationConfig struct {
	AutoAssignLead       bool `json:"auto_assign_lead"`
	NotifyLeadOnBlocked  bool `json:"notify_lead_on_blocked"`
}

// loadAutomation reads metadata.automation off a project. Missing keys default
// to false. Returns the config + the project's resolved lead so handlers can
// short-circuit if a rule fires but there's nobody to act on.
func loadAutomation(ctx context.Context, db *pgxpool.Pool, projectID uuid.UUID) (AutomationConfig, error) {
	var raw []byte
	if err := db.QueryRow(ctx, `SELECT metadata FROM projects WHERE id=$1`, projectID).Scan(&raw); err != nil {
		return AutomationConfig{}, err
	}
	var meta map[string]any
	_ = json.Unmarshal(raw, &meta)
	cfg := AutomationConfig{}
	if a, ok := meta["automation"].(map[string]any); ok {
		if v, _ := a["auto_assign_lead"].(bool); v {
			cfg.AutoAssignLead = v
		}
		if v, _ := a["notify_lead_on_blocked"].(bool); v {
			cfg.NotifyLeadOnBlocked = v
		}
	}
	return cfg, nil
}

// findProjectLead returns the most likely human "owner" of a project for
// automation purposes:
//   1. The project_members row with a role matching lead/manager (highest
//      allocation wins ties).
//   2. Fall back to projects.created_by.
// Returns nil if neither is available — caller should treat that as no-op.
func findProjectLead(ctx context.Context, db *pgxpool.Pool, projectID uuid.UUID) *uuid.UUID {
	var leadUID uuid.UUID
	if err := db.QueryRow(ctx, `
		SELECT user_id FROM project_members
		WHERE project_id=$1 AND removed_at IS NULL
		  AND (role ILIKE '%lead%' OR role ILIKE '%manager%')
		ORDER BY allocation DESC NULLS LAST, created_at ASC
		LIMIT 1`, projectID).Scan(&leadUID); err == nil {
		return &leadUID
	}
	var creator uuid.UUID
	if err := db.QueryRow(ctx, `SELECT COALESCE(created_by, '00000000-0000-0000-0000-000000000000'::uuid) FROM projects WHERE id=$1`, projectID).Scan(&creator); err == nil && creator != uuid.Nil {
		return &creator
	}
	return nil
}

// GetAutomation — GET /api/v1/projects/:id/automation
func (h *Projects) GetAutomation(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	cfg, err := loadAutomation(c.Request.Context(), h.db, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "project not found"})
		return
	}
	lead := findProjectLead(c.Request.Context(), h.db, id)
	var leadName, leadEmail string
	if lead != nil {
		_ = h.db.QueryRow(c, `SELECT COALESCE(full_name,''), email::text FROM users WHERE id=$1`, *lead).Scan(&leadName, &leadEmail)
	}
	c.JSON(http.StatusOK, gin.H{
		"config":     cfg,
		"lead_id":    lead,
		"lead_name":  leadName,
		"lead_email": leadEmail,
	})
}

// PutAutomation — PUT /api/v1/projects/:id/automation
// Whitelisted keys are merged into projects.metadata.automation. Unknown
// fields are dropped to keep the JSONB tidy.
func (h *Projects) PutAutomation(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	var req AutomationConfig
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	patch, _ := json.Marshal(map[string]any{
		"automation": map[string]any{
			"auto_assign_lead":       req.AutoAssignLead,
			"notify_lead_on_blocked": req.NotifyLeadOnBlocked,
		},
	})
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	_ = uid // reserved for audit when we wire it
	if _, err := h.db.Exec(c, `
		UPDATE projects
		   SET metadata = metadata || $2::jsonb,
		       updated_at = now()
		 WHERE id=$1`, id, patch); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "config": req})
}
