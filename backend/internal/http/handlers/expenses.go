package handlers

import (
	"net/http"
	"strings"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Expenses struct{ db *pgxpool.Pool }

func NewExpenses(db *pgxpool.Pool) *Expenses { return &Expenses{db: db} }

// ExpenseCategories is the canonical category catalog. Frontend pickers and
// any category-based aggregations reference this list directly.
var ExpenseCategories = []struct {
	Key, Label string
}{
	{"travel",         "Travel"},
	{"accommodation",  "Accommodation"},
	{"equipment",      "Equipment"},
	{"software",       "Software / Licenses"},
	{"subcontractor",  "Subcontractor"},
	{"materials",      "Materials & Supplies"},
	{"marketing",      "Marketing & Promo"},
	{"training",       "Training"},
	{"fees",           "Permits / Fees"},
	{"hospitality",    "Hospitality"},
	{"communications", "Communications"},
	{"other",          "Other"},
}

func (h *Expenses) Categories(c *gin.Context) {
	out := make([]gin.H, 0, len(ExpenseCategories))
	for _, cat := range ExpenseCategories {
		out = append(out, gin.H{"key": cat.Key, "label": cat.Label})
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

func validCategory(k string) bool {
	for _, cat := range ExpenseCategories {
		if cat.Key == k {
			return true
		}
	}
	return false
}

// List — GET /api/v1/projects/:id/expenses
// Tenant-scoped, project-scoped. Newest first, plus a totals object grouping
// spend by category so the UI can render a quick breakdown without extra calls.
func (h *Expenses) List(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	pid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	rows, err := h.db.Query(c, `
		SELECT e.id, e.category, e.vendor, e.description, e.amount::float8, e.currency,
		       e.incurred_on, e.notes, e.created_at,
		       e.created_by, COALESCE(u.full_name, ''), COALESCE(u.email::text, '')
		  FROM expenses e
		  LEFT JOIN users u ON u.id = e.created_by
		 WHERE e.tenant_id=$1 AND e.project_id=$2
		 ORDER BY e.incurred_on DESC, e.created_at DESC`, tid, pid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	byCategory := map[string]float64{}
	totalsByCcy := map[string]float64{}
	for rows.Next() {
		var (
			id              uuid.UUID
			createdBy       *uuid.UUID
			cat, vendor, desc, currency, notes, byName, byEmail string
			amount          float64
			incurredOn      any
			created         any
		)
		if err := rows.Scan(&id, &cat, &vendor, &desc, &amount, &currency, &incurredOn, &notes, &created, &createdBy, &byName, &byEmail); err == nil {
			byCategory[cat] += amount
			totalsByCcy[currency] += amount
			out = append(out, gin.H{
				"id":         id,
				"category":   cat,
				"vendor":     vendor,
				"description": desc,
				"amount":     amount,
				"currency":   currency,
				"incurred_on": incurredOn,
				"notes":      notes,
				"created_at": created,
				"created_by": createdBy,
				"creator_name":  byName,
				"creator_email": byEmail,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"items": out,
		"totals": gin.H{
			"by_category": byCategory,
			"by_currency": totalsByCcy,
			"count":       len(out),
		},
	})
}

// Add — POST /api/v1/projects/:id/expenses
func (h *Expenses) Add(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	pid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	var req struct {
		Category    string  `json:"category"   binding:"required"`
		Vendor      string  `json:"vendor"`
		Description string  `json:"description"`
		Amount      float64 `json:"amount"     binding:"required,gt=0"`
		Currency    string  `json:"currency"`
		IncurredOn  string  `json:"incurred_on" binding:"required"`
		Notes       string  `json:"notes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	req.Category = strings.ToLower(strings.TrimSpace(req.Category))
	if !validCategory(req.Category) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown category"})
		return
	}
	if strings.TrimSpace(req.Currency) == "" {
		req.Currency = "NGN"
	}
	// Project must belong to this tenant.
	var ok bool
	if err := h.db.QueryRow(c,
		`SELECT EXISTS (SELECT 1 FROM projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL)`,
		pid, tid).Scan(&ok); err != nil || !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "project not found"})
		return
	}
	var id uuid.UUID
	if err := h.db.QueryRow(c, `
		INSERT INTO expenses (tenant_id, project_id, category, vendor, description, amount, currency, incurred_on, notes, created_by)
		VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,$7,$8::date,NULLIF($9,''),$10)
		RETURNING id`,
		tid, pid, req.Category, req.Vendor, req.Description, req.Amount, req.Currency, req.IncurredOn, req.Notes, uid).Scan(&id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

// Delete — DELETE /api/v1/projects/:id/expenses/:expenseId
func (h *Expenses) Delete(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	pid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	eid, err := uuid.Parse(c.Param("expenseId"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad expenseId"})
		return
	}
	tag, err := h.db.Exec(c, `DELETE FROM expenses WHERE id=$1 AND project_id=$2 AND tenant_id=$3`, eid, pid, tid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "expense not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
