package handlers

import (
	"net/http"
	"time"

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
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}
	if err := auth.VerifyPassword(req.Password, hash); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}
	if mfaEnabled {
		ch := uuid.NewString()
		_, _ = a.db.Exec(c, `INSERT INTO mfa_challenges (id, user_id, expires_at) VALUES ($1, $2, $3)`,
			ch, userID, time.Now().Add(5*time.Minute))
		c.JSON(http.StatusOK, mfaChallenge{Challenge: ch})
		return
	}
	tok, err := auth.Issue(a.jwtConfig(), userID, tenantID, roles)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token issue"})
		return
	}
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
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid code"})
		return
	}
	_, _ = a.db.Exec(c, `DELETE FROM mfa_challenges WHERE id = $1`, req.Challenge)
	tok, err := auth.Issue(a.jwtConfig(), userID, tenantID, roles)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token issue"})
		return
	}
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
	var email, name string
	_ = a.db.QueryRow(c, `SELECT email, full_name FROM users WHERE id = $1`, uid).Scan(&email, &name)
	c.JSON(http.StatusOK, gin.H{
		"id":        uid,
		"tenant_id": tid,
		"email":     email,
		"name":      name,
		"roles":     roles,
	})
}

func (a *Auth) jwtConfig() auth.JWTConfig {
	return auth.JWTConfig{
		AccessSecret:  []byte(a.cfg.JWTAccessSecret),
		RefreshSecret: []byte(a.cfg.JWTRefreshSecret),
		AccessTTL:     a.cfg.JWTAccessTTL,
		RefreshTTL:    a.cfg.JWTRefreshTTL,
	}
}
