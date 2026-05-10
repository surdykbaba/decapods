package handlers

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	authpkg "github.com/decapods/pgdp/backend/internal/auth"
	"github.com/decapods/pgdp/backend/internal/notifications"
	"github.com/decapods/pgdp/backend/internal/platform/config"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const passwordResetTTL = 15 * time.Minute

type PasswordReset struct {
	db     *pgxpool.Pool
	mailer *notifications.Mailer
	cfg    *config.Config
}

func NewPasswordReset(db *pgxpool.Pool, mailer *notifications.Mailer, cfg *config.Config) *PasswordReset {
	return &PasswordReset{db: db, mailer: mailer, cfg: cfg}
}

// Request — POST /auth/forgot-password  body: { email }
// Always returns 200 to avoid leaking which addresses are registered. If the
// email matches a real account we mint a one-shot token and dispatch the email
// fire-and-forget. Token lifetime: 15 minutes.
func (h *PasswordReset) Request(c *gin.Context) {
	var req struct {
		Email string `json:"email" binding:"required,email"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))

	var (
		userID   uuid.UUID
		tenantID uuid.UUID
		fullName string
	)
	err := h.db.QueryRow(c, `
		SELECT id, tenant_id, COALESCE(full_name, '')
		  FROM users
		 WHERE lower(email::text) = $1 AND deleted_at IS NULL
		 LIMIT 1`, email).Scan(&userID, &tenantID, &fullName)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		// Pretend everything is fine — same 200/timing as the happy path.
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	expires := time.Now().Add(passwordResetTTL)

	// Invalidate any older unused tokens for this user, then insert a fresh one.
	if _, err := h.db.Exec(c, `
		UPDATE password_reset_tokens SET used_at=now()
		 WHERE user_id=$1 AND used_at IS NULL`, userID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if _, err := h.db.Exec(c, `
		INSERT INTO password_reset_tokens (user_id, token, expires_at, requester_ip)
		VALUES ($1, $2, $3, $4)`,
		userID, token, expires, c.ClientIP()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	h.dispatchEmail(c.Request.Context(), tenantID, email, fullName, token)

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Reset — POST /auth/reset-password  body: { token, password }
// Consumes the token (single-use) and replaces the user's password hash.
func (h *PasswordReset) Reset(c *gin.Context) {
	var req struct {
		Token    string `json:"token"    binding:"required"`
		Password string `json:"password" binding:"required,min=8"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var (
		id         uuid.UUID
		userID     uuid.UUID
		expiresAt  time.Time
		usedAt     *time.Time
	)
	err := h.db.QueryRow(c, `
		SELECT id, user_id, expires_at, used_at
		  FROM password_reset_tokens
		 WHERE token=$1
		 LIMIT 1`, req.Token).Scan(&id, &userID, &expiresAt, &usedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "This reset link is invalid.", "code": "invalid_token"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if usedAt != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "This reset link has already been used.", "code": "used_token"})
		return
	}
	if time.Now().After(expiresAt) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "This reset link has expired. Request a new one.", "code": "expired_token"})
		return
	}

	hash, err := authpkg.HashPassword(req.Password)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	tx, err := h.db.Begin(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(c)

	if _, err := tx.Exec(c, `
		UPDATE users SET password_hash=$1, status='active', updated_at=now()
		 WHERE id=$2 AND deleted_at IS NULL`, hash, userID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if _, err := tx.Exec(c, `
		UPDATE password_reset_tokens SET used_at=now() WHERE id=$1`, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := tx.Commit(c); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Verify — GET /auth/reset-password/:token
// Lets the SPA confirm the token is good before showing the new-password form.
func (h *PasswordReset) Verify(c *gin.Context) {
	token := c.Param("token")
	if token == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing token"})
		return
	}
	var (
		email     string
		expiresAt time.Time
		usedAt    *time.Time
	)
	err := h.db.QueryRow(c, `
		SELECT u.email::text, t.expires_at, t.used_at
		  FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
		 WHERE t.token = $1
		 LIMIT 1`, token).Scan(&email, &expiresAt, &usedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"valid": false, "reason": "invalid"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if usedAt != nil {
		c.JSON(http.StatusOK, gin.H{"valid": false, "reason": "used"})
		return
	}
	if time.Now().After(expiresAt) {
		c.JSON(http.StatusOK, gin.H{"valid": false, "reason": "expired"})
		return
	}
	// Mask everything but the first character to hint at the right account.
	masked := maskEmail(email)
	c.JSON(http.StatusOK, gin.H{"valid": true, "email": masked, "expires_at": expiresAt})
}

func maskEmail(e string) string {
	at := strings.IndexByte(e, '@')
	if at <= 1 {
		return e
	}
	local := e[:at]
	dom := e[at:]
	if len(local) <= 2 {
		return local[:1] + "***" + dom
	}
	return local[:1] + strings.Repeat("•", len(local)-2) + local[len(local)-1:] + dom
}

func (h *PasswordReset) dispatchEmail(ctx context.Context, tid uuid.UUID, to, name, token string) {
	if h.mailer == nil || !h.mailer.Configured() {
		return
	}
	company := loadCompanyHeader(ctx, h.db, tid)
	publicBase := publicBaseURL(h.cfg)
	link := fmt.Sprintf("%s/reset-password/%s", publicBase, token)

	greeting := strings.TrimSpace(name)
	if greeting == "" {
		greeting = to
	}

	subject := "Reset your D'Accubin password"
	plain := fmt.Sprintf(
		"Hi %s,\n\nWe received a request to reset your password on %s.\n\nUse the link below to set a new password. It expires in 15 minutes:\n\n%s\n\nIf you didn't ask for this, you can safely ignore this email — your password stays as it is.",
		greeting, company.DisplayName(), link,
	)
	html := fmt.Sprintf(`<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937">
<div style="max-width:560px;margin:24px auto;padding:24px;border:1px solid #e5e7eb;border-radius:14px;background:#faf7f1">
<h1 style="margin:0 0 8px;font-size:22px;color:#0f172a">Reset your password</h1>
<p style="margin:0 0 14px">Hi %s — someone (hopefully you) asked to reset your password on %s.</p>
<p style="margin:0 0 18px"><a href="%s" style="background:#0F7B97;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Set a new password</a></p>
<p style="font-size:12px;color:#64748b;margin:0">Or paste this URL into your browser:<br/><a href="%s">%s</a></p>
<p style="font-size:11px;color:#94a3b8;margin-top:18px">For your security, this link expires in 15 minutes and can only be used once. If you didn't ask for this email, you can safely ignore it.</p>
</div></body></html>`,
		htmlEscape(greeting), htmlEscape(company.DisplayName()), link, link, link,
	)

	go func(em notifications.Email) {
		if err := h.mailer.Send(context.Background(), em); err != nil {
			slog.Warn("password reset email failed", "to", em.To, "err", err)
		}
	}(notifications.Email{To: to, Subject: subject, Plain: plain, HTML: html})
}
