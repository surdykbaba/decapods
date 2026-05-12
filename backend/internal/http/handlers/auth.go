package handlers

import (
	"net/http"
	"time"

	"github.com/decapods/pgdp/backend/internal/audit"
	"github.com/decapods/pgdp/backend/internal/auth"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/platform/config"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Auth struct {
	db  *pgxpool.Pool
	cfg *config.Config
}

func NewAuth(db *pgxpool.Pool, cfg *config.Config) *Auth { return &Auth{db: db, cfg: cfg} }

type loginReq struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=8"`
}

type mfaChallenge struct {
	Challenge string `json:"mfa_challenge"`
}

func (a *Auth) Login(c *gin.Context) {
	var req loginReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var (
		userID, tenantID uuid.UUID
		hash             string
		mfaEnabled       bool
		roles            []string
	)
	row := a.db.QueryRow(c, `
		SELECT u.id, u.tenant_id, u.password_hash, u.mfa_enabled,
		       COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}')
		FROM users u
		LEFT JOIN user_roles ur ON ur.user_id = u.id
		LEFT JOIN roles r ON r.id = ur.role_id
		WHERE u.email = $1 AND u.deleted_at IS NULL
		GROUP BY u.id`, req.Email)
	if err := row.Scan(&userID, &tenantID, &hash, &mfaEnabled, &roles); err != nil {
		// Unknown email — no tenant context, so we can't write to audit_log
		// (tenant_id is NOT NULL). The application logs still capture the
		// attempt via the access log middleware.
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}
	if err := auth.VerifyPassword(req.Password, hash); err != nil {
		audit.WriteHTTP(c, a.db, c, tenantID, &userID, "auth.login.failure", "user", userID,
			map[string]any{"email": req.Email, "reason": "bad_password"})
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}
	if mfaEnabled {
		ch := uuid.NewString()
		_, _ = a.db.Exec(c, `INSERT INTO mfa_challenges (id, user_id, expires_at) VALUES ($1, $2, $3)`,
			ch, userID, time.Now().Add(5*time.Minute))
		audit.WriteHTTP(c, a.db, c, tenantID, &userID, "auth.mfa.challenge_issued", "user", userID,
			map[string]any{"email": req.Email})
		c.JSON(http.StatusOK, mfaChallenge{Challenge: ch})
		return
	}
	tok, err := auth.Issue(a.jwtConfig(), userID, tenantID, roles)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token issue"})
		return
	}
	audit.WriteHTTP(c, a.db, c, tenantID, &userID, "auth.login.success", "user", userID,
		map[string]any{"email": req.Email, "roles": roles})
	c.JSON(http.StatusOK, tok)
}

func (a *Auth) VerifyMFA(c *gin.Context) {
	var req struct {
		Challenge string `json:"mfa_challenge" binding:"required"`
		Code      string `json:"code" binding:"required,len=6"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var userID, tenantID uuid.UUID
	var secret string
	var roles []string
	row := a.db.QueryRow(c, `
		SELECT u.id, u.tenant_id, m.secret,
		       COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}')
		FROM mfa_challenges ch
		JOIN users u ON u.id = ch.user_id
		JOIN mfa_secrets m ON m.user_id = u.id
		LEFT JOIN user_roles ur ON ur.user_id = u.id
		LEFT JOIN roles r ON r.id = ur.role_id
		WHERE ch.id = $1 AND ch.expires_at > now()
		GROUP BY u.id, m.secret`, req.Challenge)
	if err := row.Scan(&userID, &tenantID, &secret, &roles); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid challenge"})
		return
	}
	if !auth.VerifyTOTP(secret, req.Code) {
		audit.WriteHTTP(c, a.db, c, tenantID, &userID, "auth.mfa.failure", "user", userID, nil)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid code"})
		return
	}
	_, _ = a.db.Exec(c, `DELETE FROM mfa_challenges WHERE id = $1`, req.Challenge)
	tok, err := auth.Issue(a.jwtConfig(), userID, tenantID, roles)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token issue"})
		return
	}
	audit.WriteHTTP(c, a.db, c, tenantID, &userID, "auth.login.success", "user", userID,
		map[string]any{"via": "mfa", "roles": roles})
	c.JSON(http.StatusOK, tok)
}

func (a *Auth) Refresh(c *gin.Context) {
	var req struct {
		RefreshToken string `json:"refresh_token" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	claims, err := auth.Parse(req.RefreshToken, []byte(a.cfg.JWTRefreshSecret))
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid refresh"})
		return
	}
	var roles []string
	_ = a.db.QueryRow(c, `SELECT COALESCE(array_agg(r.name),'{}') FROM user_roles ur
		JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, claims.UserID).Scan(&roles)
	tok, err := auth.Issue(a.jwtConfig(), claims.UserID, claims.TenantID, roles)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token issue"})
		return
	}
	c.JSON(http.StatusOK, tok)
}

func (a *Auth) Me(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	roles, _ := c.Get(mw.CtxRoles)
	var email, name, avatar string
	var mfaEnabled, mfaRequired bool
	_ = a.db.QueryRow(c, `SELECT email, full_name, COALESCE(avatar_url, ''), mfa_enabled, COALESCE(mfa_required,false)
		FROM users WHERE id = $1`, uid).
		Scan(&email, &name, &avatar, &mfaEnabled, &mfaRequired)
	c.JSON(http.StatusOK, gin.H{
		"id":           uid,
		"tenant_id":    tid,
		"email":        email,
		"name":         name,
		"roles":        roles,
		"avatar_url":   avatar,
		"mfa_enabled":  mfaEnabled,
		"mfa_required": mfaRequired,
	})
}

// ───────────────────────────────────────────────────────────────────────────
// Self-service MFA enrollment.
//
// Two-step:
//   1. POST /me/mfa/begin
//      Generates a fresh TOTP secret + otpauth URL, stores it on
//      mfa_secrets.pending_secret with a 10-min expiry. Repeated calls
//      regenerate — useful when a user closes the modal before confirming.
//   2. POST /me/mfa/confirm  { code }
//      Verifies the code against the pending secret. On success the pending
//      secret is promoted to the live secret column, users.mfa_enabled=true,
//      and any existing challenge rows are cleared.
//
// Disabling requires a current TOTP code so a stolen session can't drop MFA
// silently. Admins can override via the dedicated members endpoint.
// ───────────────────────────────────────────────────────────────────────────

func (a *Auth) BeginMFAEnrollment(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	var email, tenantName string
	_ = a.db.QueryRow(c, `SELECT u.email::text, t.name FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id=$1`, uid).
		Scan(&email, &tenantName)
	if tenantName == "" {
		tenantName = "D'Accubin"
	}

	secret, otpauth, err := auth.GenerateTOTP(tenantName, email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Upsert the pending secret into mfa_secrets. The live `secret` column is
	// left untouched until /confirm — until then the user is effectively
	// still in their previous MFA state.
	_, err = a.db.Exec(c, `
		INSERT INTO mfa_secrets (user_id, secret, pending_secret, pending_expires)
		VALUES ($1, '', $2, now() + interval '10 minutes')
		ON CONFLICT (user_id) DO UPDATE
		  SET pending_secret = EXCLUDED.pending_secret,
		      pending_expires = EXCLUDED.pending_expires`,
		uid, secret)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.WriteHTTP(c, a.db, c, tid, &uid, "auth.mfa.enroll_started", "user", uid, nil)
	c.JSON(http.StatusOK, gin.H{
		"otpauth_url": otpauth,
		"secret":      secret, // shown for manual entry as a fallback
		"expires_in":  600,
	})
}

func (a *Auth) ConfirmMFAEnrollment(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var req struct {
		Code string `json:"code" binding:"required,len=6"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var pending string
	err := a.db.QueryRow(c, `
		SELECT pending_secret FROM mfa_secrets
		 WHERE user_id=$1 AND pending_secret IS NOT NULL AND pending_expires > now()`, uid).Scan(&pending)
	if err != nil || pending == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no enrollment in progress — start over"})
		return
	}
	if !auth.VerifyTOTP(pending, req.Code) {
		audit.WriteHTTP(c, a.db, c, tid, &uid, "auth.mfa.enroll_failed", "user", uid, nil)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid code"})
		return
	}
	// Promote pending → live, flip the user flag, wipe any leftover challenges.
	tx, err := a.db.Begin(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(c)
	if _, err := tx.Exec(c, `
		UPDATE mfa_secrets
		   SET secret = pending_secret, pending_secret = NULL, pending_expires = NULL
		 WHERE user_id = $1`, uid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if _, err := tx.Exec(c, `UPDATE users SET mfa_enabled = true WHERE id = $1`, uid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	_, _ = tx.Exec(c, `DELETE FROM mfa_challenges WHERE user_id = $1`, uid)
	if err := tx.Commit(c); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.WriteHTTP(c, a.db, c, tid, &uid, "auth.mfa.enrolled", "user", uid, nil)
	c.JSON(http.StatusOK, gin.H{"ok": true, "mfa_enabled": true})
}

func (a *Auth) DisableMFA(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var req struct {
		Code string `json:"code" binding:"required,len=6"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Refuse if the admin marked the user mfa_required — they have to keep it on.
	var required bool
	_ = a.db.QueryRow(c, `SELECT COALESCE(mfa_required,false) FROM users WHERE id=$1`, uid).Scan(&required)
	if required {
		c.JSON(http.StatusForbidden, gin.H{
			"error": "Your admin has made MFA mandatory for this account.",
			"code":  "mfa_required",
		})
		return
	}
	var secret string
	if err := a.db.QueryRow(c, `SELECT secret FROM mfa_secrets WHERE user_id=$1`, uid).Scan(&secret); err != nil || secret == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "MFA is not enabled"})
		return
	}
	if !auth.VerifyTOTP(secret, req.Code) {
		audit.WriteHTTP(c, a.db, c, tid, &uid, "auth.mfa.disable_failed", "user", uid, nil)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid code"})
		return
	}
	tx, err := a.db.Begin(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(c)
	_, _ = tx.Exec(c, `DELETE FROM mfa_secrets   WHERE user_id = $1`, uid)
	_, _ = tx.Exec(c, `DELETE FROM mfa_challenges WHERE user_id = $1`, uid)
	if _, err := tx.Exec(c, `UPDATE users SET mfa_enabled = false WHERE id = $1`, uid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := tx.Commit(c); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.WriteHTTP(c, a.db, c, tid, &uid, "auth.mfa.disabled", "user", uid, nil)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// AdminSetMFARequired — PATCH /api/v1/members/:id/mfa-required { required: bool }
// Toggles the enforcement flag on another user. The user keeps access (so
// they can self-enroll) but the SPA and the user's own /me response surface
// the obligation prominently.
func (a *Auth) AdminSetMFARequired(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	var req struct {
		Required bool `json:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, err := a.db.Exec(c, `UPDATE users SET mfa_required=$1 WHERE id=$2 AND tenant_id=$3`,
		req.Required, id, tid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.WriteHTTP(c, a.db, c, tid, &actor, "auth.mfa.required_changed", "user", id, map[string]any{
		"required": req.Required,
	})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// VerifyPassword — POST /api/v1/auth/verify-password
//
// Used by the in-app lock screen: the user types their password and we
// check it without rotating their session. Authenticated route, so we
// already know the user id from the JWT. Doesn't extend the session.
func (a *Auth) VerifyPassword(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct{ Password string `json:"password" binding:"required,min=1"` }
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var hash string
	if err := a.db.QueryRow(c, `SELECT password_hash FROM users WHERE id=$1 AND deleted_at IS NULL`, uid).Scan(&hash); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "user not found"})
		return
	}
	if err := auth.VerifyPassword(req.Password, hash); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "wrong password"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (a *Auth) jwtConfig() auth.JWTConfig {
	return auth.JWTConfig{
		AccessSecret:  []byte(a.cfg.JWTAccessSecret),
		RefreshSecret: []byte(a.cfg.JWTRefreshSecret),
		AccessTTL:     a.cfg.JWTAccessTTL,
		RefreshTTL:    a.cfg.JWTRefreshTTL,
	}
}
