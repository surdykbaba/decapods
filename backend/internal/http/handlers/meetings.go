// Package handlers — meetings.go
//
// /me/meetings returns the caller's upcoming calendar items pulled from
// Microsoft Graph. The list is rendered on My Accubin so users can see
// what's on their day without leaving D'Accubin.
package handlers

import (
	"net/http"
	"strconv"
	"time"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/integrations/microsoft"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Meetings — GET /api/v1/me/meetings?days=7
//
// Returns events from now to now+N days (default 7, max 30). Surfaces a
// not-connected flag so the SPA can render the Connect Microsoft CTA
// instead of a confusing empty state.
func (h *MicrosoftOAuth) Meetings(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	days := 7
	if v, _ := strconv.Atoi(c.Query("days")); v > 0 && v <= 30 {
		days = v
	}

	token, err := h.loadValidToken(c.Request.Context(), tid, uid)
	if err != nil {
		if err == errMSNotConnected {
			c.JSON(http.StatusOK, gin.H{
				"connected": false,
				"items":     []any{},
			})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{
			"connected": false,
			"error":     err.Error(),
		})
		return
	}

	from := time.Now()
	to := from.Add(time.Duration(days) * 24 * time.Hour)
	events, err := microsoft.FetchEvents(c.Request.Context(), token, from, to)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"connected": true,
			"error":     "Could not load Microsoft calendar — " + err.Error(),
		})
		return
	}

	// Stamp a "connected_account" so the SPA can display "Showing events
	// from alice@contoso.com" without a second API call.
	var account *string
	_ = h.db.QueryRow(c, `SELECT ms_account FROM ms_oauth_tokens WHERE user_id=$1`, uid).Scan(&account)

	c.JSON(http.StatusOK, gin.H{
		"connected":         true,
		"connected_account": derefStr(account),
		"items":             events,
		"fetched_at":        time.Now().UTC(),
		"window_days":       days,
	})
}

// Mail — GET /api/v1/me/mail?top=10
//
// Returns the connected user's most recent Inbox messages from Microsoft
// Graph. Same shape as /me/meetings — a {connected, items, error?} envelope
// the SPA can render without a second status call.
func (h *MicrosoftOAuth) Mail(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	top := 10
	if v, _ := strconv.Atoi(c.Query("top")); v > 0 && v <= 50 {
		top = v
	}

	token, err := h.loadValidToken(c.Request.Context(), tid, uid)
	if err != nil {
		if err == errMSNotConnected {
			c.JSON(http.StatusOK, gin.H{"connected": false, "items": []any{}})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"connected": false, "error": err.Error()})
		return
	}

	msgs, err := microsoft.FetchRecentMail(c.Request.Context(), token, top)
	if err != nil {
		// Most common reason here is the stored token predates the Mail.Read
		// scope — the user needs to reconnect for the new permission to flow
		// through. Surface that hint in the error so the SPA can prompt.
		c.JSON(http.StatusBadGateway, gin.H{
			"connected": true,
			"error":     "Could not load mail — " + err.Error() + " (try Disconnect + Connect Microsoft if Mail.Read was just enabled)",
		})
		return
	}

	var account *string
	_ = h.db.QueryRow(c, `SELECT ms_account FROM ms_oauth_tokens WHERE user_id=$1`, uid).Scan(&account)

	c.JSON(http.StatusOK, gin.H{
		"connected":         true,
		"connected_account": derefStr(account),
		"items":             msgs,
		"fetched_at":        time.Now().UTC(),
	})
}
