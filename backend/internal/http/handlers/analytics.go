package handlers

import (
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Analytics struct{ db *pgxpool.Pool }

func NewAnalytics(db *pgxpool.Pool) *Analytics { return &Analytics{db: db} }

func (h *Analytics) Executive(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	out := gin.H{}

	var totalProjects, delayed, atRisk int
	_ = h.db.QueryRow(c, `SELECT COUNT(*) FROM projects WHERE tenant_id=$1 AND deleted_at IS NULL`, tid).Scan(&totalProjects)
	_ = h.db.QueryRow(c, `SELECT COUNT(*) FROM projects WHERE tenant_id=$1 AND deleted_at IS NULL
		AND end_date < current_date AND status NOT IN ('paid','closed')`, tid).Scan(&delayed)
	_ = h.db.QueryRow(c, `SELECT COUNT(*) FROM projects WHERE tenant_id=$1 AND deleted_at IS NULL AND health IN ('amber','red')`, tid).Scan(&atRisk)

	var invoiced, paid, outstanding float64
	_ = h.db.QueryRow(c, `SELECT COALESCE(SUM(amount),0) FROM invoices WHERE tenant_id=$1 AND status<>'draft'`, tid).Scan(&invoiced)
	_ = h.db.QueryRow(c, `SELECT COALESCE(SUM(amount),0) FROM invoices WHERE tenant_id=$1 AND status='paid'`, tid).Scan(&paid)
	outstanding = invoiced - paid

	var openViolations, slaBreaches, pendingApprovals int
	_ = h.db.QueryRow(c, `SELECT COUNT(*) FROM governance_violations WHERE tenant_id=$1 AND resolved=false`, tid).Scan(&openViolations)
	_ = h.db.QueryRow(c, `SELECT COUNT(*) FROM sla_breaches WHERE tenant_id=$1 AND resolved_at IS NULL`, tid).Scan(&slaBreaches)
	_ = h.db.QueryRow(c, `SELECT COUNT(*) FROM opportunity_approvals WHERE tenant_id=$1 AND status='pending'`, tid).Scan(&pendingApprovals)

	var avgUtil float64
	_ = h.db.QueryRow(c, `SELECT COALESCE(AVG(hours)/40.0,0) FROM (
		SELECT user_id, SUM(hours) AS hours FROM time_entries
		WHERE work_date >= current_date - 7
		GROUP BY user_id) t`).Scan(&avgUtil)

	out["portfolio"] = gin.H{"total": totalProjects, "delayed": delayed, "at_risk": atRisk}
	out["revenue"] = gin.H{"invoiced": invoiced, "paid": paid, "outstanding": outstanding}
	out["governance"] = gin.H{"open_violations": openViolations, "sla_breaches": slaBreaches, "pending_approvals": pendingApprovals}
	out["workforce"] = gin.H{"avg_utilization": avgUtil}
	c.JSON(200, out)
}

func (h *Analytics) PortfolioHealth(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c, `
		SELECT health, COUNT(*) FROM projects
		WHERE tenant_id=$1 AND deleted_at IS NULL
		GROUP BY health`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	dist := map[string]int{"green": 0, "amber": 0, "red": 0}
	for rows.Next() {
		var k string
		var v int
		if err := rows.Scan(&k, &v); err == nil {
			dist[k] = v
		}
	}
	stages := map[string]int{}
	srows, err := h.db.Query(c, `SELECT status, COUNT(*) FROM projects WHERE tenant_id=$1 GROUP BY status`, tid)
	if err == nil {
		defer srows.Close()
		for srows.Next() {
			var k string
			var v int
			if err := srows.Scan(&k, &v); err == nil {
				stages[k] = v
			}
		}
	}
	c.JSON(200, gin.H{"health": dist, "by_status": stages})
}

var _ = uuid.Nil
