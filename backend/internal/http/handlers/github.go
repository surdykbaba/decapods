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

// Status — admin-only health view of the integration. We don't return the
// actual secret; we just say whether it's configured so the UI can show a
// "ready / needs setup" badge.
func (h *GitHub) Status(c *gin.Context) {
	c.JSON(200, gin.H{
		"webhook_secret_configured": h.cfg.GitHubWebhookSecret != "",
	})
}

// ListRepos returns every linked repository in this tenant with its project,
// linker, and a couple of activity hints (counts of PRs and commits we've
// ingested via webhooks).
func (h *GitHub) ListRepos(c *gin.Context) {
	rows, err := h.db.Query(c, `
		SELECT r.id, r.owner, r.name, COALESCE(r.installation_id, 0),
		       r.project_id, p.code, p.name,
		       (SELECT COUNT(*) FROM gh_pull_requests pr WHERE pr.repo_id = r.id) AS prs,
		       (SELECT COUNT(*) FROM gh_commits c       WHERE c.repo_id = r.id) AS commits
		FROM gh_repositories r
		JOIN projects p ON p.id = r.project_id
		WHERE p.tenant_id = (SELECT tenant_id FROM users WHERE id = $1)
		  AND p.deleted_at IS NULL
		ORDER BY r.owner, r.name`,
		c.MustGet("ctx.user_id"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id, projectID         uuid.UUID
			owner, name           string
			installID             int64
			projectCode, projName string
			prs, commits          int
		)
		if err := rows.Scan(&id, &owner, &name, &installID, &projectID, &projectCode, &projName, &prs, &commits); err == nil {
			out = append(out, gin.H{
				"id":              id,
				"owner":           owner,
				"name":            name,
				"installation_id": installID,
				"project_id":      projectID,
				"project_code":    projectCode,
				"project_name":    projName,
				"pull_requests":   prs,
				"commits":         commits,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

// UnlinkRepo drops the repository link. PR / commit / deployment history
// cascades away (ON DELETE CASCADE on the FK), so the row vanishes entirely.
// Re-linking later re-creates the row fresh — we never restore the ingest.
func (h *GitHub) UnlinkRepo(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	tag, err := h.db.Exec(c, `DELETE FROM gh_repositories WHERE id = $1`, id)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "not linked"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

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
