package handlers

import (
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/notifications"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// NotificationPrefs surfaces the per-category notification tier preferences:
// what the user *will* get (immediate / digest_daily / digest_weekly / off),
// either explicitly set or inherited from the catalog default.
type NotificationPrefs struct {
	engine *notifications.Engine
}

func NewNotificationPrefs(engine *notifications.Engine) *NotificationPrefs {
	return &NotificationPrefs{engine: engine}
}

func (h *NotificationPrefs) List(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rows, err := h.engine.PrefsForUser(c, uid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	// Also surface the event catalog so the UI can show "what events fire" when expanded.
	cat := []gin.H{}
	for _, m := range notifications.Catalog {
		cat = append(cat, gin.H{
			"kind":         m.Kind,
			"category":     m.Category,
			"severity":     m.Severity,
			"default_tier": m.DefaultTier,
			"description":  m.Description,
		})
	}
	c.JSON(200, gin.H{"preferences": rows, "events": cat})
}

// RunDigest manually drains pending outbox rows for a given tier and sends a
// digest email to every recipient with queued items. Provided so the cron
// worker has a concrete target and admins can fire one mid-day for testing.
//
// POST /admin/digests/run?tier=digest_daily   (governance:write)
func (h *NotificationPrefs) RunDigest(c *gin.Context) {
	t := c.Query("tier")
	if t == "" {
		t = "digest_daily"
	}
	sum, err := h.engine.DrainDigest(c, notifications.Tier(t))
	if err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true, "tier": t, "recipients": sum.Recipients, "rows": sum.Rows})
}

func (h *NotificationPrefs) Set(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Category string `json:"category" binding:"required"`
		Tier     string `json:"tier"     binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if err := h.engine.SetPref(c, uid, notifications.Category(req.Category), notifications.Tier(req.Tier)); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}
