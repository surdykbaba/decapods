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

	// failHTML serves a plain-HTML result page on any failure. The previous
	// behaviour redirected back into the SPA with ?ms=error&detail=…, but the
	// SPA toast was eaten by some combination of service worker caching,
	// stripped query params and an unmounted card — so the admin saw nothing.
	// A static error page can't be cached away or swallowed by React state.
	failHTML := func(title, detail string) {
		renderResultPage(c, false, title, detail)
	}

	if errParam != "" {
		detail := friendlyMSError(errParam, c.Query("error_description"))
		failHTML("Microsoft sign-in rejected", detail)
		return
	}
	if code == "" || state == "" {
		failHTML("Missing parameters", "Microsoft didn't return an authorization code. Try Connect Microsoft again — codes expire fast.")
		return
	}
	uidStr, err := microsoft.ValidState([]byte(h.cfg.JWTAccessSecret), state)
	if err != nil {
		failHTML("State validation failed", "Your sign-in session expired or the state token was tampered with. Sign back into D'Accubin and retry.")
		return
	}
	uid, err := uuid.Parse(uidStr)
	if err != nil {
		failHTML("Bad user identifier", "The signed state didn't decode to a valid user — try signing out, in, and retrying.")
		return
	}
	// Find the user's tenant so we load the right Microsoft Config.
	var tid uuid.UUID
	if err := h.db.QueryRow(c, `SELECT tenant_id FROM users WHERE id=$1`, uid).Scan(&tid); err != nil {
		failHTML("User not found", "The user this sign-in belongs to is no longer in the workspace.")
		return
	}
	msCfg := loadMicrosoftConfig(c, h.db, h.cfg, tid)
	if !msCfg.Configured {
		failHTML("Workspace not configured", "An admin needs to paste the Azure AD Client ID + Secret in Settings → Microsoft Calendar.")
		return
	}

	tok, err := msCfg.Exchange(c.Request.Context(), code)
	if err != nil {
		failHTML("Token exchange failed", friendlyMSError("exchange_failed", err.Error()))
		return
	}
	account, oid, profileErr := microsoft.FetchProfile(c.Request.Context(), tok.AccessToken)
	if profileErr != nil {
		failHTML("Microsoft Graph rejected the token", friendlyMSError("graph_profile_failed", profileErr.Error()))
		return
	}

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
		failHTML("Couldn't save the token", err.Error())
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
		account     *string
		exp         *time.Time
		hasToken    bool
	)
	// connected = there's a stored row with a non-empty access token. Reading
	// access_token presence (rather than ms_account != NULL) means a partial
	// success — token saved but Graph profile fetch failed — still reports as
	// connected so the user can retry meetings without a full re-auth.
	_ = h.db.QueryRow(c, `
		SELECT ms_account, expires_at, COALESCE(NULLIF(access_token,''),'') <> ''
		  FROM ms_oauth_tokens WHERE user_id=$1`, uid).
		Scan(&account, &exp, &hasToken)
	cfg := loadMicrosoftConfig(c, h.db, h.cfg, tid)
	c.JSON(http.StatusOK, gin.H{
		"configured": cfg.Configured,
		"connected":  hasToken,
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

// renderResultPage serves a self-contained HTML result page so the user
// always sees feedback after Microsoft bounces them back, even when the SPA
// is uncooperative (service worker cache, missing toast container, etc.).
// On success we still redirect into the SPA so the calendar appears inline.
func renderResultPage(c *gin.Context, ok bool, title, detail string) {
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Type", "text/html; charset=utf-8")
	statusColor := "#dc2626"
	statusLabel := "Connection failed"
	emoji := "⚠️"
	if ok {
		statusColor = "#16a34a"
		statusLabel = "Connected"
		emoji = "✅"
	}
	// Escape so a hostile detail can't inject markup.
	safeTitle := htmlEscape(title)
	safeDetail := htmlEscape(detail)
	page := `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>` + safeTitle + ` — D'Accubin</title>
<style>
  body { margin:0; font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Manrope,sans-serif; background:#FAF7F2; color:#0b1220; display:flex; min-height:100vh; align-items:center; justify-content:center; padding:1.5rem; }
  .card { background:#fff; border:1px solid #e5e7eb; border-radius:16px; padding:2rem; max-width:560px; box-shadow:0 12px 40px rgba(0,0,0,.06); }
  .pill { display:inline-flex; align-items:center; gap:.4rem; font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; padding:.25rem .65rem; border-radius:999px; color:` + statusColor + `; background:` + statusColor + `15; border:1px solid ` + statusColor + `40; }
  h1 { font-size:1.6rem; margin:1rem 0 .25rem; line-height:1.15; }
  p.detail { margin:1rem 0 0; padding:1rem; background:#FAF7F2; border:1px solid #e5e7eb; border-radius:8px; font-size:.95rem; white-space:pre-wrap; word-break:break-word; }
  a.cta { display:inline-block; margin-top:1.5rem; background:#107B97; color:#fff; padding:.65rem 1.2rem; border-radius:999px; font-weight:700; text-decoration:none; font-size:.9rem; }
  a.cta:hover { background:#0d6c84; }
  .meta { margin-top:1rem; font-size:.8rem; color:#6b7280; }
</style>
</head><body>
<div class="card">
  <div class="pill">` + emoji + ` ` + statusLabel + `</div>
  <h1>` + safeTitle + `</h1>
  <p class="detail">` + safeDetail + `</p>
  <a class="cta" href="/my-work">Back to D'Accubin</a>
  <div class="meta">This page is served directly by the backend so feedback survives caching.</div>
</div>
</body></html>`
	c.String(http.StatusOK, page)
}

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
	// Graph profile lookup failures — happen *after* a successful token
	// exchange when the access token doesn't have the right delegated
	// permissions. The Azure app registration usually needs User.Read added
	// (and sometimes admin consent) under API permissions → Microsoft Graph.
	case code == "graph_profile_failed" && strings.Contains(description, "InvalidAuthenticationToken"):
		return "Token rejected by Microsoft Graph. Add User.Read delegated permission to the Azure app (API permissions → Microsoft Graph) and grant admin consent."
	case code == "graph_profile_failed" && strings.Contains(description, "Forbidden"):
		return "Microsoft Graph denied /me access. The Azure app is missing User.Read or admin consent for it hasn't been granted."
	case code == "graph_profile_failed":
		d := strings.TrimSpace(description)
		if len(d) > 140 {
			d = d[:139] + "…"
		}
		return "Microsoft accepted the sign-in but Graph profile lookup failed: " + d
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
