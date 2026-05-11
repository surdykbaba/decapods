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
