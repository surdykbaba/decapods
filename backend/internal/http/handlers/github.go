package handlers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"

	"github.com/decapods/pgdp/backend/internal/platform/config"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type GitHub struct {
	db  *pgxpool.Pool
	cfg *config.Config
}

func NewGitHub(db *pgxpool.Pool, cfg *config.Config) *GitHub { return &GitHub{db: db, cfg: cfg} }

func (h *GitHub) LinkRepo(c *gin.Context) {
	var req struct {
		ProjectID  uuid.UUID `json:"project_id" binding:"required"`
		Owner      string    `json:"owner" binding:"required"`
		Repo       string    `json:"repo" binding:"required"`
		InstallID  int64     `json:"installation_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	id := uuid.New()
	_, err := h.db.Exec(c, `
		INSERT INTO gh_repositories (id, project_id, owner, name, installation_id)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (owner, name) DO UPDATE SET project_id=EXCLUDED.project_id, installation_id=EXCLUDED.installation_id`,
		id, req.ProjectID, req.Owner, req.Repo, req.InstallID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

// Webhook verifies the signature, persists the raw event, and enqueues
// processing to a worker.
func (h *GitHub) Webhook(c *gin.Context) {
	body, _ := io.ReadAll(c.Request.Body)
	sig := c.GetHeader("X-Hub-Signature-256")
	if !verifySig(h.cfg.GitHubWebhookSecret, sig, body) {
		c.AbortWithStatus(http.StatusUnauthorized)
		return
	}
	event := c.GetHeader("X-GitHub-Event")
	delivery := c.GetHeader("X-GitHub-Delivery")
	_, err := h.db.Exec(c, `INSERT INTO gh_webhook_events (id, delivery_id, event, payload)
		VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (delivery_id) DO NOTHING`,
		uuid.New(), delivery, event, string(body))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusAccepted)
}

func verifySig(secret, header string, body []byte) bool {
	if secret == "" || len(header) < 8 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(header))
}
