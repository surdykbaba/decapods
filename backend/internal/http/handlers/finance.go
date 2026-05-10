package handlers

import (
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Finance struct{ db *pgxpool.Pool }

func NewFinance(db *pgxpool.Pool) *Finance { return &Finance{db: db} }

func (h *Finance) ListInvoices(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c, `
		SELECT id, number, project_id, amount, currency, status, issued_on, due_on
		FROM invoices WHERE tenant_id=$1 AND deleted_at IS NULL
		ORDER BY issued_on DESC NULLS LAST LIMIT 200`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id, project          uuid.UUID
			number, status, cur  string
			amount               float64
			issued, due          any
		)
		if err := rows.Scan(&id, &number, &project, &amount, &cur, &status, &issued, &due); err == nil {
			out = append(out, gin.H{
				"id": id, "number": number, "project_id": project,
				"amount": amount, "currency": cur, "status": status,
				"issued_on": issued, "due_on": due,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

func (h *Finance) CreateInvoice(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		ProjectID   uuid.UUID `json:"project_id" binding:"required"`
		MilestoneID uuid.UUID `json:"milestone_id"`
		Number      string    `json:"number" binding:"required"`
		Amount      float64   `json:"amount" binding:"required,gt=0"`
		Currency    string    `json:"currency"`
		IssuedOn    string    `json:"issued_on"`
		DueOn       string    `json:"due_on"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	id := uuid.New()
	_, err := h.db.Exec(c, `
		INSERT INTO invoices (id, tenant_id, project_id, milestone_id, number, amount, currency,
		                      status, issued_on, due_on, created_by)
		VALUES ($1,$2,$3, NULLIF($4,'00000000-0000-0000-0000-000000000000')::uuid, $5,$6,
		        COALESCE(NULLIF($7,''),'USD'),'draft', NULLIF($8,'')::date, NULLIF($9,'')::date, $10)`,
		id, tid, req.ProjectID, req.MilestoneID, req.Number, req.Amount, req.Currency,
		req.IssuedOn, req.DueOn, uid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

func (h *Finance) RecordPayment(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var req struct {
		InvoiceID uuid.UUID `json:"invoice_id" binding:"required"`
		Amount    float64   `json:"amount" binding:"required,gt=0"`
		PaidOn    string    `json:"paid_on" binding:"required"`
		Method    string    `json:"method"`
		Reference string    `json:"reference"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	pid := uuid.New()
	tx, err := h.db.Begin(c)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(c)
	if _, err := tx.Exec(c, `INSERT INTO payments (id, tenant_id, invoice_id, amount, paid_on, method, reference)
		VALUES ($1,$2,$3,$4, $5::date, $6, $7)`,
		pid, tid, req.InvoiceID, req.Amount, req.PaidOn, req.Method, req.Reference); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if _, err := tx.Exec(c, `
		UPDATE invoices SET status =
			CASE WHEN (SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id=invoices.id) >= invoices.amount
			     THEN 'paid' ELSE 'partially_paid' END,
		    updated_at = now()
		WHERE id=$1`, req.InvoiceID); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if err := tx.Commit(c); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": pid})
}

func (h *Finance) Receivables(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c, `
		SELECT
		  CASE
		    WHEN current_date - due_on <= 0  THEN 'current'
		    WHEN current_date - due_on <= 30 THEN '0_30'
		    WHEN current_date - due_on <= 60 THEN '31_60'
		    WHEN current_date - due_on <= 90 THEN '61_90'
		    ELSE '90_plus'
		  END AS bucket,
		  SUM(amount - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.invoice_id = i.id),0)) AS outstanding
		FROM invoices i
		WHERE tenant_id=$1 AND status IN ('issued','partially_paid') AND deleted_at IS NULL
		GROUP BY bucket`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := map[string]float64{}
	for rows.Next() {
		var b string
		var v float64
		if err := rows.Scan(&b, &v); err == nil {
			out[b] = v
		}
	}
	c.JSON(200, gin.H{"aging": out})
}
