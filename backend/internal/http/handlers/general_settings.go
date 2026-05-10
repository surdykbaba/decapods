package handlers

import (
	"encoding/json"
	"net/http"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type GeneralSettings struct {
	db *pgxpool.Pool
}

func NewGeneralSettings(db *pgxpool.Pool) *GeneralSettings { return &GeneralSettings{db: db} }

type generalSettings struct {
	DefaultCurrency string `json:"default_currency"`
}

const defaultCurrency = "NGN"

func (h *GeneralSettings) Get(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var raw []byte
	if err := h.db.QueryRow(c, `SELECT settings FROM tenants WHERE id=$1`, tid).Scan(&raw); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var s map[string]any
	_ = json.Unmarshal(raw, &s)
	out := generalSettings{DefaultCurrency: defaultCurrency}
	if v, ok := s["default_currency"].(string); ok && v != "" {
		out.DefaultCurrency = v
	}
	c.JSON(http.StatusOK, out)
}

func (h *GeneralSettings) Put(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var body generalSettings
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.DefaultCurrency == "" {
		body.DefaultCurrency = defaultCurrency
	}
	_, err := h.db.Exec(c, `
		UPDATE tenants
		   SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('default_currency', $2::text),
		       updated_at = now()
		 WHERE id = $1`, tid, body.DefaultCurrency)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, body)
}
