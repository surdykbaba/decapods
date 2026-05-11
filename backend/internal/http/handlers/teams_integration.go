// Package handlers — teams_integration.go
//
// Settings endpoints for Microsoft Teams Incoming Webhooks. Get returns the
// stored subscriptions; Put replaces them wholesale (simpler than per-row
// CRUD for a small list); Test fires a probe Adaptive Card so an admin can
// verify a freshly-pasted URL before relying on it for real events.
package handlers

import (
	"context"
	"net/http"

	"github.com/decapods/pgdp/backend/internal/audit"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/notifications"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type TeamsIntegration struct{ db *pgxpool.Pool }

func NewTeamsIntegration(db *pgxpool.Pool) *TeamsIntegration {
	return &TeamsIntegration{db: db}
}

// Get — GET /api/v1/settings/teams
//
// Returns the tenant's webhook list. URLs are echoed back as-is to the
// requesting admin (governance:write gated). We don't mask them because
// rotating a webhook only takes a paste — the secrecy bar is low.
func (h *TeamsIntegration) Get(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	cfg := notifications.LoadTeamsConfig(c.Request.Context(), h.db, tid)
	c.JSON(http.StatusOK, gin.H{
		"webhooks":   cfg.Webhooks,
		"categories": teamsCategoryOptions(),
	})
}

// Put — PUT /api/v1/settings/teams
//
// Replaces the webhook list wholesale. Admin sends back the full array of
// subscriptions; we normalise + persist. Server-side IDs are preserved when
// the admin keeps the original `id`, generated when missing.
func (h *TeamsIntegration) Put(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var body struct {
		Webhooks []notifications.TeamsWebhook `json:"webhooks"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := notifications.SaveTeamsConfig(c.Request.Context(), h.db, tid, notifications.TeamsConfig{
		Webhooks: body.Webhooks,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Re-read so the response carries server-side IDs/timestamps for newly
	// added rows — saves the client an immediate GET.
	cfg := notifications.LoadTeamsConfig(c.Request.Context(), h.db, tid)
	audit.WriteHTTP(c, h.db, c, tid, &actor, "settings.teams_changed", "tenant", tid, gin.H{
		"webhook_count": len(cfg.Webhooks),
	})
	c.JSON(http.StatusOK, gin.H{"webhooks": cfg.Webhooks})
}

// Test — POST /api/v1/settings/teams/test/:id
//
// Fires a probe Adaptive Card to one of the configured webhooks. We post
// the same MessageCard shape the engine uses so a successful test means
// real events will look right too.
func (h *TeamsIntegration) Test(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id := c.Param("id")
	cfg := notifications.LoadTeamsConfig(c.Request.Context(), h.db, tid)
	var hook *notifications.TeamsWebhook
	for i := range cfg.Webhooks {
		if cfg.Webhooks[i].ID == id {
			hook = &cfg.Webhooks[i]
			break
		}
	}
	if hook == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "webhook not found"})
		return
	}
	card := map[string]any{
		"@type":      "MessageCard",
		"@context":   "https://schema.org/extensions",
		"summary":    "D'Accubin test message",
		"themeColor": "0F7B97",
		"title":      "✅ Connected to D'Accubin",
		"text":       "If you're seeing this card, the webhook is wired correctly. Real events will arrive here.",
		"sections": []map[string]any{
			{"facts": []map[string]any{
				{"name": "Channel", "value": hook.Name},
				{"name": "Filter",  "value": joinOrAll(hook.Categories)},
				{"name": "Min severity", "value": hook.MinSeverity},
			}},
		},
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*1_000_000_000) // 10s
	defer cancel()
	status, err := notifications.PostTeamsCard(ctx, hook.URL, card)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "status": status})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "status": status})
}

// teamsCategoryOptions exposes the same category enum the engine uses, plus
// a friendly label per option for the settings UI. Keeping it co-located
// avoids a second source of truth.
func teamsCategoryOptions() []gin.H {
	return []gin.H{
		{"value": "account",     "label": "Account"},
		{"value": "pipeline",    "label": "Pipeline"},
		{"value": "delivery",    "label": "Delivery"},
		{"value": "tasks",       "label": "Tasks"},
		{"value": "governance",  "label": "Governance & leave"},
		{"value": "risk",        "label": "Risk & escalation"},
		{"value": "finance",     "label": "Finance"},
		{"value": "vendor",      "label": "Vendor delivery"},
		{"value": "relations",   "label": "Relationships"},
		{"value": "exec_digest", "label": "Exec digest"},
	}
}

func joinOrAll(cats []string) string {
	if len(cats) == 0 {
		return "All categories"
	}
	out := ""
	for i, c := range cats {
		if i > 0 {
			out += ", "
		}
		out += c
	}
	return out
}
