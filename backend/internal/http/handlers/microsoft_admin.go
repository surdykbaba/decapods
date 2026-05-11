// Package handlers — microsoft_admin.go
//
// Tenant-level Microsoft / Entra ID app credentials. An admin pastes their
// Azure AD app's client ID + secret here once; every user's "Connect
// Microsoft" button then routes through it.
//
// We never echo the client_secret back — once written it's stamped as
// "stored" so the form shows the right state without exposing the value.
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/decapods/pgdp/backend/internal/audit"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/platform/config"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type MicrosoftAdmin struct {
	db  *pgxpool.Pool
	cfg *config.Config
}

func NewMicrosoftAdmin(db *pgxpool.Pool, cfg *config.Config) *MicrosoftAdmin {
	return &MicrosoftAdmin{db: db, cfg: cfg}
}

// Get — GET /api/v1/settings/microsoft
//
// Returns the stored credentials minus the secret. Includes the redirect
// URI the admin needs to paste into the Azure AD app registration.
func (h *MicrosoftAdmin) Get(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	clientID, _, tenantHint := loadRawMicrosoftCreds(c.Request.Context(), h.db, tid)
	cfg := loadMicrosoftConfig(c, h.db, h.cfg, tid)
	c.JSON(http.StatusOK, gin.H{
		"client_id":     clientID,
		"tenant_hint":   tenantHint,
		"secret_stored": cfg.Configured && hasStoredSecret(c.Request.Context(), h.db, tid),
		"redirect_uri":  cfg.RedirectURI,
		"configured":    cfg.Configured,
	})
}

// Put — PUT /api/v1/settings/microsoft
//
// Body: { client_id, client_secret, tenant_hint }. Empty client_secret means
// "keep the stored value" so the admin can edit other fields without
// re-pasting the secret each time.
func (h *MicrosoftAdmin) Put(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var body struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
		TenantHint   string `json:"tenant_hint"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	body.ClientID = strings.TrimSpace(body.ClientID)
	body.TenantHint = strings.TrimSpace(body.TenantHint)
	if body.TenantHint == "" {
		body.TenantHint = "common"
	}

	current := map[string]any{
		"client_id":   body.ClientID,
		"tenant_hint": body.TenantHint,
	}
	if strings.TrimSpace(body.ClientSecret) != "" {
		current["client_secret"] = body.ClientSecret
	} else {
		// Preserve the existing secret — re-read and re-write it so the JSON
		// merge keeps the field present.
		_, existing, _ := loadRawMicrosoftCreds(c.Request.Context(), h.db, tid)
		if existing != "" {
			current["client_secret"] = existing
		}
	}

	patch, err := json.Marshal(map[string]any{"microsoft": current})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if _, err := h.db.Exec(c, `
		UPDATE tenants
		   SET settings   = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
		       updated_at = now()
		 WHERE id = $1`, tid, patch); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.WriteHTTP(c, h.db, c, tid, &actor, "settings.microsoft_changed", "tenant", tid, gin.H{
		"client_id_set":   body.ClientID != "",
		"secret_rotated":  strings.TrimSpace(body.ClientSecret) != "",
		"tenant_hint":     body.TenantHint,
	})

	cfg := loadMicrosoftConfig(c, h.db, h.cfg, tid)
	c.JSON(http.StatusOK, gin.H{
		"client_id":     body.ClientID,
		"tenant_hint":   body.TenantHint,
		"secret_stored": cfg.Configured,
		"redirect_uri":  cfg.RedirectURI,
		"configured":    cfg.Configured,
	})
}

func loadRawMicrosoftCreds(ctx context.Context, db *pgxpool.Pool, tid uuid.UUID) (clientID, clientSecret, tenantHint string) {
	var raw []byte
	if err := db.QueryRow(ctx, `SELECT settings FROM tenants WHERE id=$1`, tid).Scan(&raw); err != nil || len(raw) == 0 {
		return "", "", ""
	}
	var s struct {
		Microsoft struct {
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
			TenantHint   string `json:"tenant_hint"`
		} `json:"microsoft"`
	}
	_ = json.Unmarshal(raw, &s)
	return s.Microsoft.ClientID, s.Microsoft.ClientSecret, s.Microsoft.TenantHint
}

func hasStoredSecret(ctx context.Context, db *pgxpool.Pool, tid uuid.UUID) bool {
	_, sec, _ := loadRawMicrosoftCreds(ctx, db, tid)
	return strings.TrimSpace(sec) != ""
}
