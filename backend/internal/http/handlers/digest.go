// Weekly digest endpoints:
//   GET    /me/digest-prefs       — read opt-in state + last send
//   PUT    /me/digest-prefs       — toggle opt-in
//   POST   /me/digest-preview     — send the digest to the caller now
//   POST   /admin/digest/run      — admin-only: kick off SendDue sweep
package handlers

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/decapods/pgdp/backend/internal/digest"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
)

type Digest struct {
	db     *pgxpool.Pool
	sender *digest.Sender
}

func NewDigest(db *pgxpool.Pool, sender *digest.Sender) *Digest {
	return &Digest{db: db, sender: sender}
}

func (h *Digest) GetPrefs(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var enabled bool
	var lastSent *time.Time
	err := h.db.QueryRow(c.Request.Context(),
		`SELECT weekly_digest_enabled, weekly_digest_last_sent_at FROM users WHERE id = $1`,
		uid,
	).Scan(&enabled, &lastSent)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	resp := gin.H{"weekly_digest_enabled": enabled}
	if lastSent != nil {
		resp["weekly_digest_last_sent_at"] = lastSent
	}
	c.JSON(http.StatusOK, resp)
}

func (h *Digest) UpdatePrefs(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var body struct {
		WeeklyDigestEnabled *bool `json:"weekly_digest_enabled"`
	}
	if err := c.BindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.WeeklyDigestEnabled == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "weekly_digest_enabled is required"})
		return
	}
	if _, err := h.db.Exec(c.Request.Context(),
		`UPDATE users SET weekly_digest_enabled = $1, updated_at = now() WHERE id = $2`,
		*body.WeeklyDigestEnabled, uid,
	); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"weekly_digest_enabled": *body.WeeklyDigestEnabled})
}

// Preview sends the digest to the caller immediately, regardless of
// day-of-week. Useful for "send me a sample" buttons. Honours opt-in
// state by default — pass ?force=1 to bypass when configured users
// want to see what they'd be getting before flipping the toggle.
func (h *Digest) Preview(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var email, fullName string
	if err := h.db.QueryRow(c.Request.Context(),
		`SELECT email, full_name FROM users WHERE id = $1`,
		uid,
	).Scan(&email, &fullName); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	r := digest.Recipient{
		ID:       uid.String(),
		TenantID: tid.String(),
		Email:    email,
		FullName: fullName,
	}
	if err := h.sender.SendForUser(c.Request.Context(), r, time.Now()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"sent": true, "to": email})
}

// AdminRun fires SendDue immediately. Useful for first-Monday
// kick-offs or recovering from a missed window. Admin-gated at the
// route layer.
func (h *Digest) AdminRun(c *gin.Context) {
	sent, skipped, err := h.sender.SendDue(c.Request.Context(), time.Now())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"sent": sent, "skipped": skipped})
}
