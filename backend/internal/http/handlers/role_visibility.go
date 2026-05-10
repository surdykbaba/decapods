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

type RoleVisibility struct {
	db *pgxpool.Pool
}

func NewRoleVisibility(db *pgxpool.Pool) *RoleVisibility { return &RoleVisibility{db: db} }

// Sections are the top-level nav keys the operator can gate per role. Keys
// match the frontend `navTop` definition. `my_work` and `settings` are always
// visible — every signed-in user can see their own work, and super_admins
// always need a way to fix their own config. Order is the display order.
var NavSections = []struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}{
	{"my_work",       "My Accubin"},
	{"pipeline",      "Pipeline"},
	{"projects",      "Projects"},
	{"workforce",     "Workforce"},
	{"members",       "Members"},
	{"stakeholders",  "Stakeholders"},
	{"vendors",       "Vendors"},
	{"agents",        "PR & Agents"},
	{"finance",       "Finance"},
	{"files",         "Files & media"},
	{"leave",         "Leave"},
	{"settings",      "Settings"},
}

// Defaults — used when the tenant hasn't customised. super_admin always sees
// everything (and any role with super_admin gets a passthrough at the read
// layer anyway). Keep the matrix opinionated rather than empty so a fresh
// workspace is usable without visiting Settings first.
var DefaultRoleVisibility = map[string][]string{
	"my_work":      {"*"}, // everyone
	"pipeline":     {"super_admin", "ceo", "coo", "business_dev", "delivery_manager", "project_manager", "finance"},
	"projects":     {"super_admin", "ceo", "coo", "delivery_manager", "project_manager", "engineer", "qa", "finance", "auditor", "business_dev"},
	"workforce":    {"super_admin", "ceo", "coo", "hr", "delivery_manager", "project_manager", "finance"},
	"members":      {"super_admin", "ceo", "coo", "hr"},
	"stakeholders": {"super_admin", "ceo", "coo", "business_dev", "delivery_manager", "project_manager"},
	"vendors":      {"super_admin", "ceo", "coo", "delivery_manager", "finance", "compliance_officer"},
	"agents":       {"super_admin", "ceo", "coo", "business_dev", "compliance_officer"},
	"finance":      {"super_admin", "ceo", "coo", "finance", "auditor"},
	"files":        {"*"}, // everyone — same default as my_work
	"leave":        {"*"}, // everyone can request leave; visibility of others' is gated by handlers
	// Settings menu is visible to everyone by default. The page *contents*
	// (workflow edits, team rates, governance, integrations) are still gated
	// by `governance:write` at the API level — non-admins see a read-only view.
	// Workspaces that need to lock the menu down entirely can override this
	// in Settings → Role visibility.
	"settings":     {"*"},
}

type roleVisibilityResponse struct {
	Sections    []sectionMeta            `json:"sections"`
	Roles       []roleMeta               `json:"roles"`
	Matrix      map[string][]string      `json:"matrix"` // section_key -> []role_name (or ["*"])
}

type sectionMeta struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Fixed bool   `json:"fixed"` // can't toggle — always visible
}

type roleMeta struct {
	Name  string `json:"name"`
	Label string `json:"label"`
}

func (h *RoleVisibility) Get(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	matrix := h.loadMatrix(c.Request.Context(), tid)
	roles, err := h.loadRoles(c.Request.Context(), tid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	sections := make([]sectionMeta, 0, len(NavSections))
	for _, s := range NavSections {
		sections = append(sections, sectionMeta{
			Key: s.Key, Label: s.Label,
			// Only "my_work" is permanently fixed — every member needs their own
			// dashboard. Settings used to be fixed-to-everyone too, but the
			// workspace owner should be able to lock it down to admins.
			Fixed: s.Key == "my_work",
		})
	}
	c.JSON(http.StatusOK, roleVisibilityResponse{
		Sections: sections, Roles: roles, Matrix: matrix,
	})
}

func (h *RoleVisibility) Put(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var body struct {
		Matrix map[string][]string `json:"matrix" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Force super_admin everywhere — the admin lock should never be one
	// settings save away from being unrecoverable.
	for k, roles := range body.Matrix {
		has := false
		for _, r := range roles {
			if r == "super_admin" || r == "*" { has = true; break }
		}
		if !has {
			body.Matrix[k] = append(roles, "super_admin")
		}
	}
	patch, err := json.Marshal(map[string]any{"role_visibility": body.Matrix})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if _, err := h.db.Exec(c, `
		UPDATE tenants
		   SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
		       updated_at = now()
		 WHERE id = $1`, tid, patch); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "matrix": body.Matrix})
}

// MeVisibility returns the section keys the calling user can see, based on
// their roles ∩ tenant matrix. Used by the SPA to filter the sidebar.
func (h *RoleVisibility) MeVisibility(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rolesRaw, _ := c.Get(mw.CtxRoles)
	userRoles, _ := rolesRaw.([]string)
	matrix := h.loadMatrix(c.Request.Context(), tid)

	visible := []string{}
	for _, s := range NavSections {
		allowed := matrix[s.Key]
		if s.Key == "my_work" || s.Key == "settings" || roleListAllows(allowed, userRoles) {
			visible = append(visible, s.Key)
		}
	}
	c.JSON(http.StatusOK, gin.H{"sections": visible})
}

func (h *RoleVisibility) loadMatrix(ctx context.Context, tid uuid.UUID) map[string][]string {
	out := map[string][]string{}
	for k, v := range DefaultRoleVisibility {
		out[k] = append([]string(nil), v...)
	}
	var raw []byte
	if err := h.db.QueryRow(ctx, `SELECT settings FROM tenants WHERE id=$1`, tid).Scan(&raw); err != nil || len(raw) == 0 {
		return out
	}
	var s map[string]any
	_ = json.Unmarshal(raw, &s)
	rv, ok := s["role_visibility"].(map[string]any)
	if !ok {
		return out
	}
	for k, raw := range rv {
		if arr, ok := raw.([]any); ok {
			roles := make([]string, 0, len(arr))
			for _, r := range arr {
				if s, ok := r.(string); ok { roles = append(roles, s) }
			}
			out[k] = roles
		}
	}
	return out
}

func (h *RoleVisibility) loadRoles(ctx context.Context, tid uuid.UUID) ([]roleMeta, error) {
	rows, err := h.db.Query(ctx, `
		SELECT name, COALESCE(description, '')
		  FROM roles
		 WHERE tenant_id IS NULL OR tenant_id = $1
		 ORDER BY name`, tid)
	if err != nil { return nil, err }
	defer rows.Close()
	out := []roleMeta{}
	for rows.Next() {
		var name, desc string
		if err := rows.Scan(&name, &desc); err == nil {
			label := name
			if desc != "" { label = desc }
			out = append(out, roleMeta{Name: name, Label: label})
		}
	}
	return out, nil
}

func roleListAllows(allowed, userRoles []string) bool {
	for _, a := range allowed {
		if a == "*" { return true }
		for _, r := range userRoles {
			if r == a { return true }
			if r == "super_admin" { return true }
		}
	}
	return false
}
