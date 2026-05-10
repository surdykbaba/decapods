package handlers

import (
	"net/http"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type TeamRates struct {
	db *pgxpool.Pool
}

func NewTeamRates(db *pgxpool.Pool) *TeamRates { return &TeamRates{db: db} }

type teamRate struct {
	ID        uuid.UUID `json:"id,omitempty"`
	Name      string    `json:"name"`
	Kind      string    `json:"kind"` // internal | external
	DailyRate float64   `json:"daily_rate"`
	Currency  string    `json:"currency"`
	Active    bool      `json:"active"`
}

func (h *TeamRates) List(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c, `
		SELECT id, name, kind, daily_rate::float8, currency, active
		FROM team_rates
		WHERE tenant_id=$1
		ORDER BY kind, name`, tid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []teamRate{}
	for rows.Next() {
		var r teamRate
		if err := rows.Scan(&r.ID, &r.Name, &r.Kind, &r.DailyRate, &r.Currency, &r.Active); err == nil {
			out = append(out, r)
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"rates":      out,
		"currencies": []string{"USD", "NGN", "EUR", "GBP", "ZAR", "KES", "GHS", "XAF"},
	})
}

func (h *TeamRates) Upsert(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var req struct {
		Rates []teamRate `json:"rates"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	tx, err := h.db.Begin(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(c)

	if _, err := tx.Exec(c, `UPDATE team_rates SET active=false WHERE tenant_id=$1`, tid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	for i, r := range req.Rates {
		if r.Name == "" || r.DailyRate < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid rate", "index": i})
			return
		}
		if r.Kind != "internal" && r.Kind != "external" {
			r.Kind = "internal"
		}
		if r.Currency == "" {
			r.Currency = "NGN"
		}
		if _, err := tx.Exec(c, `
			INSERT INTO team_rates (tenant_id, name, kind, daily_rate, currency, active, updated_at)
			VALUES ($1,$2,$3,$4,$5,true,now())
			ON CONFLICT (tenant_id, name)
			DO UPDATE SET kind=EXCLUDED.kind, daily_rate=EXCLUDED.daily_rate,
			              currency=EXCLUDED.currency, active=true, updated_at=now()`,
			tid, r.Name, r.Kind, r.DailyRate, r.Currency); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	if err := tx.Commit(c); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *TeamRates) Delete(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	if _, err := h.db.Exec(c, `DELETE FROM team_rates WHERE id=$1 AND tenant_id=$2`, id, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}
