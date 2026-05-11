// Package handlers — microsoft_oauth.go
//
// Per-user Microsoft OAuth flow. Three endpoints:
//
//   1. GET  /me/microsoft/start    — builds the consent URL and redirects.
//      State is HMAC-signed with the JWT access secret so the callback can
//      verify the user without a server-side session table.
//   2. GET  /auth/microsoft/callback — exchanges the auth code, fetches the
//      profile, persists the token, redirects back to the SPA.
//   3. POST /me/microsoft/disconnect — deletes the token row.
//   4. GET  /me/microsoft/status   — tiny "are you connected" probe so the
//      SPA can decide whether to show Connect or the meetings card.
//
// Admin endpoint for credentials lives in the settings handler (Get/Put).
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/decapods/pgdp/backend/internal/audit"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/integrations/microsoft"
	"github.com/decapods/pgdp/backend/internal/platform/config"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type MicrosoftOAuth struct {
	db  *pgxpool.Pool
	cfg *config.Config
}

func NewMicrosoftOAuth(db *pgxpool.Pool, cfg *config.Config) *MicrosoftOAuth {
	return &MicrosoftOAuth{db: db, cfg: cfg}
}

// Start — GET /api/v1/me/microsoft/start
//
// Builds the Microsoft consent URL with a state signed by the JWT access
// secret so the callback can verify it cheaply. Returns a JSON { url } so
// the SPA opens it in a popup or full redirect — whichever fits the UX.
func (h *MicrosoftOAuth) Start(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	msCfg := loadMicrosoftConfig(c, h.db, h.cfg, tid)
	if !msCfg.Configured {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "Microsoft integration not configured. Ask an admin to set the Azure AD client ID + secret in Settings.",
			"code":  "ms_not_configured",
		})
		return
	}
	state, err := microsoft.SignState([]byte(h.cfg.JWTAccessSecret), uid.String())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"url": msCfg.StartAuthURL(state)})
}

// Callback — GET /api/v1/auth/microsoft/callback
//
// Microsoft redirects the browser here with ?code=… and the original state.
// We verify state, exchange the code for tokens, fetch the connected
// account's UPN/oid for display, persist everything, and redirect the user
// back to a fixed landing page in the SPA.
//
// This endpoint is intentionally NOT under the authenticated group: Microsoft
// has no idea about our JWTs. The HMAC-signed state proves the user.
func (h *MicrosoftOAuth) Callback(c *gin.Context) {
	code := c.Query("code")
	state := c.Query("state")
	errParam := c.Query("error")

	// Land on Today (where MeetingsCard lives) so the connect-result toast
	// and ms-status refetch actually fire — the Profile tab doesn't mount
	// the card, so feedback was being swallowed there.
	landing := publicLandingURL(h.cfg, "/my-work?ms=" )

	if errParam != "" {
		// User cancelled or Microsoft rejected. Pass through a friendly
		// summary so the SPA toast has something actionable instead of just
		// "invalid_request".
		detail := friendlyMSError(errParam, c.Query("error_description"))
		c.Redirect(http.StatusFound, landing+"error&detail="+url.QueryEscape(detail))
		return
	}
	if code == "" || state == "" {
		c.Redirect(http.StatusFound, landing+"missing")
		return
	}
	uidStr, err := microsoft.ValidState([]byte(h.cfg.JWTAccessSecret), state)
	if err != nil {
		c.Redirect(http.StatusFound, landing+"bad_state")
		return
	}
	uid, err := uuid.Parse(uidStr)
	if err != nil {
		c.Redirect(http.StatusFound, landing+"bad_uid")
		return
	}
	// Find the user's tenant so we load the right Microsoft Config.
	var tid uuid.UUID
	if err := h.db.QueryRow(c, `SELECT tenant_id FROM users WHERE id=$1`, uid).Scan(&tid); err != nil {
		c.Redirect(http.StatusFound, landing+"unknown_user")
		return
	}
	msCfg := loadMicrosoftConfig(c, h.db, h.cfg, tid)
	if !msCfg.Configured {
		c.Redirect(http.StatusFound, landing+"not_configured")
		return
	}

	tok, err := msCfg.Exchange(c.Request.Context(), code)
	if err != nil {
		// Surface Microsoft's actual rejection so the admin can act on it
		// instead of staring at a generic "exchange_failed". The library
		// formats errors as "microsoft token endpoint returned NNN: {json}",
		// and the JSON usually contains an AADSTS code our friendly mapper
		// already knows how to translate.
		c.Redirect(http.StatusFound, landing+"error&detail="+url.QueryEscape(friendlyMSError("exchange_failed", err.Error())))
		return
	}
	account, oid, _ := microsoft.FetchProfile(c.Request.Context(), tok.AccessToken)

	if _, err := h.db.Exec(c, `
		INSERT INTO ms_oauth_tokens
		  (user_id, tenant_id, ms_account, ms_oid, access_token, refresh_token, scope, expires_at)
		VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),$5,$6,$7,$8)
		ON CONFLICT (user_id) DO UPDATE SET
		  ms_account    = COALESCE(NULLIF(EXCLUDED.ms_account,''), ms_oauth_tokens.ms_account),
		  ms_oid        = COALESCE(NULLIF(EXCLUDED.ms_oid,''),     ms_oauth_tokens.ms_oid),
		  access_token  = EXCLUDED.access_token,
		  refresh_token = EXCLUDED.refresh_token,
		  scope         = EXCLUDED.scope,
		  expires_at    = EXCLUDED.expires_at,
		  updated_at    = now()`,
		uid, tid, account, oid, tok.AccessToken, tok.RefreshToken, tok.Scope, tok.ExpiresAt); err != nil {
		c.Redirect(http.StatusFound, landing+"error&detail="+url.QueryEscape("Token persist failed: "+err.Error()))
		return
	}
	audit.WriteHTTP(c, h.db, c, tid, &uid, "integration.microsoft.connected", "user", uid, gin.H{
		"account": account,
	})
	c.Redirect(http.StatusFound, landing+"connected")
}

// Disconnect — POST /api/v1/me/microsoft/disconnect
func (h *MicrosoftOAuth) Disconnect(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	if _, err := h.db.Exec(c, `DELETE FROM ms_oauth_tokens WHERE user_id=$1`, uid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.WriteHTTP(c, h.db, c, tid, &uid, "integration.microsoft.disconnected", "user", uid, nil)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Status — GET /api/v1/me/microsoft/status
//
// Lightweight probe used by every page that wants to know "is the user
// connected, and as whom". Doesn't validate the token — that happens on the
// first /me/meetings call.
func (h *MicrosoftOAuth) Status(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var (
		account *string
		exp     *time.Time
	)
	_ = h.db.QueryRow(c, `SELECT ms_account, expires_at FROM ms_oauth_tokens WHERE user_id=$1`, uid).
		Scan(&account, &exp)
	cfg := loadMicrosoftConfig(c, h.db, h.cfg, tid)
	c.JSON(http.StatusOK, gin.H{
		"configured": cfg.Configured,
		"connected":  account != nil,
		"account":    derefStr(account),
		"expires_at": exp,
	})
}

// loadValidToken returns a fresh access token, refreshing on the fly if the
// stored one is within 60s of expiry. Returns ErrNoConnection if the user
// has never connected. Persists rotated refresh_tokens back to the DB.
func (h *MicrosoftOAuth) loadValidToken(ctx context.Context, tid, uid uuid.UUID) (string, error) {
	var (
		access, refresh, scope string
		exp                    time.Time
	)
	err := h.db.QueryRow(ctx, `SELECT access_token, refresh_token, scope, expires_at FROM ms_oauth_tokens WHERE user_id=$1`, uid).
		Scan(&access, &refresh, &scope, &exp)
	if err != nil {
		return "", errNoConnection
	}
	if time.Until(exp) > 60*time.Second {
		return access, nil
	}
	cfg := loadMicrosoftConfigCtx(ctx, h.db, h.cfg, tid)
	if !cfg.Configured {
		return "", errNoConnection
	}
	tok, err := cfg.Refresh(ctx, refresh)
	if err != nil {
		return "", err
	}
	newRefresh := tok.RefreshToken
	if newRefresh == "" {
		newRefresh = refresh // Microsoft sometimes omits — reuse the old one.
	}
	_, _ = h.db.Exec(ctx, `
		UPDATE ms_oauth_tokens SET
		  access_token  = $1,
		  refresh_token = $2,
		  scope         = COALESCE(NULLIF($3,''), scope),
		  expires_at    = $4,
		  updated_at    = now()
		WHERE user_id   = $5`,
		tok.AccessToken, newRefresh, tok.Scope, tok.ExpiresAt, uid)
	return tok.AccessToken, nil
}

var errNoConnection = &gin.Error{Err: errMSNotConnected, Type: gin.ErrorTypePublic}

// errMSNotConnected is the sentinel returned upstream; we wrap it once in
// errNoConnection so handlers can keep using `err == errNoConnection`.
type errStr string

func (e errStr) Error() string { return string(e) }

const errMSNotConnected errStr = "microsoft account not connected"

// friendlyMSError turns Microsoft's verbose AADSTSxxxxx error_description
// into a one-line, actionable message that fits in a toast. Falls back to the
// raw error code if we don't have a tailored hint — better than nothing, and
// the admin can search the code if they need to dig further.
func friendlyMSError(code, description string) string {
	switch {
	case strings.Contains(description, "AADSTS50194"):
		return "Azure app is single-tenant. Paste your Directory (tenant) ID into Tenant hint in Settings → Microsoft Calendar."
	case strings.Contains(description, "AADSTS700016"):
		return "Client ID isn't recognised in your tenant. Double-check it's the Application (client) ID GUID, not the secret."
	case strings.Contains(description, "AADSTS50011"):
		return "Redirect URI mismatch. Register https://myaccubin.com/api/v1/auth/microsoft/callback in Azure → Authentication."
	case strings.Contains(description, "AADSTS65001"):
		return "Consent required. An admin needs to grant tenant-wide consent for the calendar scopes."
	// Token-exchange specific — show up when consent succeeds but the token
	// POST is rejected. These tend to be Client Secret problems, redirect
	// URI mismatches on the back-channel, or PKCE/platform misconfig.
	case strings.Contains(description, "AADSTS7000215"):
		return "Invalid client secret. Generate a new secret in Azure (Certificates & secrets) and paste the Value into Client secret."
	case strings.Contains(description, "AADSTS7000222") || strings.Contains(description, "AADSTS700024"):
		return "Client secret expired. Generate a new secret in Azure and re-paste the Value."
	case strings.Contains(description, "AADSTS9002313"):
		return "Invalid auth code. Try Connect Microsoft again — codes are single-use and expire fast."
	case strings.Contains(description, "AADSTS90002"):
		return "Tenant hint not recognised. Use your Directory (tenant) ID GUID from Azure → Overview."
	case strings.Contains(description, "AADSTS500113"):
		return "Reply URL not registered. Add https://myaccubin.com/api/v1/auth/microsoft/callback to Azure → Authentication → Web platform."
	case strings.Contains(description, `"error":"invalid_client"`):
		return "Invalid client. Either Client ID or Client secret is wrong — re-paste both from Azure."
	case strings.Contains(description, `"error":"invalid_grant"`):
		return "Auth grant rejected. Usually means the redirect URI registered in Azure doesn't match https://myaccubin.com/api/v1/auth/microsoft/callback exactly."
	case code == "access_denied":
		return "Sign-in was cancelled."
	}
	// Trim to keep the URL (and the toast) sane.
	desc := strings.TrimSpace(description)
	if desc == "" {
		return code
	}
	if len(desc) > 180 {
		desc = desc[:177] + "…"
	}
	return desc
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// loadMicrosoftConfig + loadMicrosoftConfigCtx — gin and context flavours of
// the same lookup. Tenant credentials live under tenants.settings.microsoft;
// redirect URI defaults to <public origin>/api/v1/auth/microsoft/callback.
func loadMicrosoftConfig(c *gin.Context, db *pgxpool.Pool, appCfg *config.Config, tid uuid.UUID) microsoft.Config {
	return loadMicrosoftConfigCtx(c.Request.Context(), db, appCfg, tid)
}

func loadMicrosoftConfigCtx(ctx context.Context, db *pgxpool.Pool, appCfg *config.Config, tid uuid.UUID) microsoft.Config {
	out := microsoft.Config{TenantHint: "common"}
	var raw []byte
	if err := db.QueryRow(ctx, `SELECT settings FROM tenants WHERE id=$1`, tid).Scan(&raw); err != nil || len(raw) == 0 {
		return out
	}
	type ms struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
		TenantHint   string `json:"tenant_hint"`
	}
	var s struct {
		Microsoft ms `json:"microsoft"`
	}
	_ = json.Unmarshal(raw, &s)
	out.ClientID = strings.TrimSpace(s.Microsoft.ClientID)
	out.ClientSecret = strings.TrimSpace(s.Microsoft.ClientSecret)
	if t := strings.TrimSpace(s.Microsoft.TenantHint); t != "" {
		out.TenantHint = t
	}
	// Redirect URI is derived from the configured public origin so the same
	// Azure AD app works across staging + prod without per-env paste.
	out.RedirectURI = publicLandingURL(appCfg, "/api/v1/auth/microsoft/callback")
	out.Configured = out.ClientID != "" && out.ClientSecret != ""
	return out
}

// publicLandingURL prepends the app's public origin to a relative path. Used
// for both the OAuth redirect URI and the SPA bounce-back URL.
func publicLandingURL(cfg *config.Config, path string) string {
	base := ""
	if cfg != nil && len(cfg.AllowedOrigins) > 0 {
		base = strings.TrimSuffix(strings.TrimSpace(cfg.AllowedOrigins[0]), "/")
		if base == "" || base == "*" {
			base = ""
		}
	}
	if base == "" {
		base = "https://myaccubin.com"
	}
	return base + path
}
