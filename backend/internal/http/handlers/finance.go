package handlers

import (
	"strings"
	"time"

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
		SELECT i.id, i.number, i.project_id, i.amount, i.currency, i.status, i.issued_on, i.due_on,
		       COALESCE(p.name,'') AS project_name, COALESCE(p.code,''),
		       COALESCE((SELECT SUM(amount) FROM payments pm WHERE pm.invoice_id=i.id), 0) AS paid
		FROM invoices i
		LEFT JOIN projects p ON p.id = i.project_id AND p.deleted_at IS NULL
		WHERE i.tenant_id=$1 AND i.deleted_at IS NULL
		ORDER BY i.issued_on DESC NULLS LAST, i.created_at DESC LIMIT 500`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id, project                                                 uuid.UUID
			number, status, cur, projectName, projectCode               string
			amount, paid                                                float64
			issued, due                                                 *time.Time
		)
		if err := rows.Scan(&id, &number, &project, &amount, &cur, &status, &issued, &due,
			&projectName, &projectCode, &paid); err == nil {
			out = append(out, gin.H{
				"id": id, "number": number, "project_id": project,
				"project_name": projectName, "project_code": projectCode,
				"amount": amount, "paid": paid, "outstanding": amount - paid,
				"currency": cur, "status": status,
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
		IRN         string    `json:"irn"` // optional Invoice Reference Number from FIRS / e-Invoicing
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	id := uuid.New()
	_, err := h.db.Exec(c, `
		INSERT INTO invoices (id, tenant_id, project_id, milestone_id, number, amount, currency,
		                      status, issued_on, due_on, created_by, irn)
		VALUES ($1,$2,$3, NULLIF($4,'00000000-0000-0000-0000-000000000000')::uuid, $5,$6,
		        COALESCE(NULLIF($7,''),'USD'),'draft', NULLIF($8,'')::date, NULLIF($9,'')::date, $10,
		        NULLIF($11,''))`,
		id, tid, req.ProjectID, req.MilestoneID, req.Number, req.Amount, req.Currency,
		req.IssuedOn, req.DueOn, uid, req.IRN)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

// LookupIRN tries to resolve an Invoice Reference Number to invoice details.
// Two layers:
//   1. **Local hit** — if we've seen this IRN before in this tenant, return the
//      matching invoice's amount/currency/dates as a pre-fill. Useful for
//      "I'm re-entering the same invoice" cases.
//   2. **External fetch** — when a FIRS / e-Invoicing provider is wired, this is
//      where the credentials-bearing call lives. Today it returns 501 so the UI
//      can fall back to "use the IRN as the invoice number, fill the rest in".
//
// Body: { irn: string }
func (h *Finance) LookupIRN(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var req struct {
		IRN string `json:"irn" binding:"required,min=4"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	irn := strings.TrimSpace(req.IRN)
	if len(irn) > 128 {
		c.JSON(400, gin.H{"error": "IRN too long"})
		return
	}

	// Local hit first — covers re-entry / duplicate prevention.
	var (
		number, currency string
		amount           float64
		issuedOn, dueOn  *time.Time
		projectID        *uuid.UUID
	)
	err := h.db.QueryRow(c, `
		SELECT number, amount, currency, issued_on, due_on, project_id
		FROM invoices
		WHERE tenant_id=$1 AND irn=$2 AND deleted_at IS NULL
		ORDER BY created_at DESC LIMIT 1`, tid, irn).Scan(
		&number, &amount, &currency, &issuedOn, &dueOn, &projectID,
	)
	if err == nil {
		c.JSON(200, gin.H{
			"source":     "local",
			"irn":        irn,
			"number":     number,
			"amount":     amount,
			"currency":   currency,
			"issued_on":  issuedOn,
			"due_on":     dueOn,
			"project_id": projectID,
			"warning":    "An invoice with this IRN already exists in your workspace. Confirm before re-issuing.",
		})
		return
	}

	// No local hit. Honest 501 — the e-Invoicing provider integration is the
	// next-pass hook. The UI uses the IRN as the invoice number as a fallback.
	c.JSON(501, gin.H{
		"error":  "IRN lookup against the e-Invoicing provider isn't wired yet.",
		"code":   "irn_lookup_unconfigured",
		"action": "use_as_number",
		"hint":   "We'll save the IRN on the invoice. Fill in amount and dates manually for now — the lookup will populate them once FIRS credentials are provisioned.",
	})
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

// Summary is a single-shot dashboard endpoint. Runs five small queries and
// returns everything the finance page needs so the frontend doesn't have to
// fan out four round-trips.
//
// Currency strategy: invoices live in their stated currency, never converted
// here. Totals are returned bucketed by currency + a "primary" pick for the UI
// to feature (the currency with the largest billed volume).
func (h *Finance) Summary(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	// 1. Per-currency totals + status counts in one pass over invoices.
	type row struct {
		currency  string
		billed    float64
		collected float64
		outstanding float64
		count     map[string]int
	}
	byCcy := map[string]*row{}
	statusCount := map[string]int{"draft": 0, "issued": 0, "partially_paid": 0, "paid": 0, "void": 0}
	rows, err := h.db.Query(c, `
		SELECT i.currency, i.status, i.amount,
		       COALESCE((SELECT SUM(amount) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid
		FROM invoices i
		WHERE i.tenant_id=$1 AND i.deleted_at IS NULL`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	for rows.Next() {
		var ccy, st string
		var amt, paid float64
		if err := rows.Scan(&ccy, &st, &amt, &paid); err != nil { continue }
		if ccy == "" { ccy = "NGN" }
		r := byCcy[ccy]
		if r == nil {
			r = &row{currency: ccy, count: map[string]int{}}
			byCcy[ccy] = r
		}
		// Drafts aren't billed yet — only issued / partially_paid / paid count toward billed/collected.
		if st != "draft" && st != "void" {
			r.billed += amt
			r.collected += paid
			r.outstanding += (amt - paid)
		}
		statusCount[st]++
	}
	rows.Close()

	// Pick a primary currency — the one with the largest billed total. Default NGN.
	primary := "NGN"
	var bestBilled float64
	for ccy, r := range byCcy {
		if r.billed > bestBilled {
			primary = ccy
			bestBilled = r.billed
		}
	}
	currencyTotals := []gin.H{}
	for _, r := range byCcy {
		currencyTotals = append(currencyTotals, gin.H{
			"currency":    r.currency,
			"billed":      r.billed,
			"collected":   r.collected,
			"outstanding": r.outstanding,
		})
	}

	// 2. Aging — same buckets as Receivables.
	aging := map[string]float64{"current": 0, "0_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0}
	arows, err := h.db.Query(c, `
		SELECT
		  CASE
		    WHEN due_on IS NULL OR current_date - due_on <= 0 THEN 'current'
		    WHEN current_date - due_on <= 30 THEN '0_30'
		    WHEN current_date - due_on <= 60 THEN '31_60'
		    WHEN current_date - due_on <= 90 THEN '61_90'
		    ELSE '90_plus'
		  END AS bucket,
		  SUM(amount - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.invoice_id = i.id),0)) AS outstanding
		FROM invoices i
		WHERE tenant_id=$1 AND status IN ('issued','partially_paid') AND deleted_at IS NULL
		GROUP BY bucket`, tid)
	if err == nil {
		for arows.Next() {
			var b string; var v float64
			if err := arows.Scan(&b, &v); err == nil { aging[b] = v }
		}
		arows.Close()
	}

	// 3. Pipeline at risk — opportunities approved-but-not-yet-collected. Counted
	// as future revenue at the stages where work is committed but cash hasn't landed.
	var pipelineAtRisk float64
	_ = h.db.QueryRow(c, `
		SELECT COALESCE(SUM(estimated_value), 0) FROM opportunities
		WHERE tenant_id=$1 AND deleted_at IS NULL
		  AND stage IN ('approved','contracting','planning','in_progress','qa_review','client_acceptance','invoiced')`,
		tid).Scan(&pipelineAtRisk)

	// 4. Top 5 unpaid invoices by outstanding balance.
	topUnpaid := []gin.H{}
	urows, uerr := h.db.Query(c, `
		SELECT i.id, i.number, i.amount, i.currency, i.status, i.issued_on, i.due_on,
		       COALESCE(p.name, '') AS project_name, p.id AS project_id,
		       COALESCE((SELECT SUM(amount) FROM payments pm WHERE pm.invoice_id=i.id),0) AS paid
		FROM invoices i
		LEFT JOIN projects p ON p.id = i.project_id AND p.deleted_at IS NULL
		WHERE i.tenant_id=$1 AND i.deleted_at IS NULL AND i.status IN ('issued','partially_paid')
		ORDER BY (i.amount - COALESCE((SELECT SUM(amount) FROM payments pm WHERE pm.invoice_id=i.id),0)) DESC
		LIMIT 5`, tid)
	if uerr == nil {
		for urows.Next() {
			var (
				id                                    uuid.UUID
				number, status, currency, projectName string
				amount, paid                          float64
				issued, due                           *time.Time
				projectID                             *uuid.UUID
			)
			if err := urows.Scan(&id, &number, &amount, &currency, &status, &issued, &due,
				&projectName, &projectID, &paid); err == nil {
				daysOverdue := 0
				if due != nil && time.Now().After(*due) {
					daysOverdue = int(time.Since(*due).Hours() / 24)
				}
				topUnpaid = append(topUnpaid, gin.H{
					"id": id, "number": number, "amount": amount, "currency": currency,
					"status": status, "issued_on": issued, "due_on": due,
					"project_name": projectName, "project_id": projectID,
					"outstanding": amount - paid,
					"days_overdue": daysOverdue,
				})
			}
		}
		urows.Close()
	}

	// 5. Recent payments (last 10), with invoice + project context.
	recentPayments := []gin.H{}
	prows, perr := h.db.Query(c, `
		SELECT p.id, p.amount, p.paid_on, COALESCE(p.method,''), COALESCE(p.reference,''),
		       i.number, i.currency, COALESCE(pr.name,''), pr.id
		FROM payments p
		JOIN invoices i ON i.id = p.invoice_id
		LEFT JOIN projects pr ON pr.id = i.project_id AND pr.deleted_at IS NULL
		WHERE p.tenant_id=$1
		ORDER BY p.paid_on DESC, p.created_at DESC LIMIT 10`, tid)
	if perr == nil {
		for prows.Next() {
			var (
				pid                                                  uuid.UUID
				amount                                               float64
				paidOn                                               *time.Time
				method, ref, invoiceNumber, currency, projectName  string
				projectID                                            *uuid.UUID
			)
			if err := prows.Scan(&pid, &amount, &paidOn, &method, &ref,
				&invoiceNumber, &currency, &projectName, &projectID); err == nil {
				recentPayments = append(recentPayments, gin.H{
					"id": pid, "amount": amount, "paid_on": paidOn,
					"method": method, "reference": ref,
					"invoice_number": invoiceNumber, "currency": currency,
					"project_name": projectName, "project_id": projectID,
				})
			}
		}
		prows.Close()
	}

	c.JSON(200, gin.H{
		"primary_currency": primary,
		"by_currency":      currencyTotals,
		"status_counts":    statusCount,
		"aging":            aging,
		"pipeline_at_risk": pipelineAtRisk,
		"top_unpaid":       topUnpaid,
		"recent_payments":  recentPayments,
	})
}

// Billable returns the things finance should action right now: opportunities
// where the client has accepted but no invoice has gone out, plus project
// milestones marked done that aren't yet billed. Powers the "Ready to invoice"
// queue at the top of the invoices page.
func (h *Finance) Billable(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	out := []gin.H{}

	// 1. Opportunities at client_acceptance — handed over, contractually billable.
	//    Use estimated_value as the suggested amount; client can override on the
	//    invoice form.
	orows, err := h.db.Query(c, `
		SELECT o.id, o.title, o.estimated_value, COALESCE(o.currency,'NGN'),
		       p.id, COALESCE(p.name,''), COALESCE(p.code,''),
		       o.delivery_deadline,
		       (SELECT COUNT(*) FROM invoices i
		        WHERE i.tenant_id=o.tenant_id AND i.project_id=p.id AND i.deleted_at IS NULL) AS invoice_count
		FROM opportunities o
		LEFT JOIN projects p ON p.opportunity_id = o.id AND p.deleted_at IS NULL
		WHERE o.tenant_id=$1 AND o.deleted_at IS NULL
		  AND o.stage = 'client_acceptance'`, tid)
	if err == nil {
		for orows.Next() {
			var (
				oid                                  uuid.UUID
				title, currency, projectName, code   string
				value                                float64
				projectID                            *uuid.UUID
				deadline                             *time.Time
				invCount                             int
			)
			if err := orows.Scan(&oid, &title, &value, &currency, &projectID, &projectName, &code, &deadline, &invCount); err == nil {
				out = append(out, gin.H{
					"kind":           "opportunity",
					"id":             oid,
					"title":          title,
					"suggested_amount": value,
					"currency":       currency,
					"project_id":     projectID,
					"project_name":   projectName,
					"project_code":   code,
					"due_on":         deadline,
					"reason":         "Client accepted — invoice when ready",
					"existing_invoices": invCount,
				})
			}
		}
		orows.Close()
	}

	// 2. Completed milestones with no invoice attached.
	mrows, err := h.db.Query(c, `
		SELECT m.id, m.title, m.due_on, m.project_id,
		       COALESCE(p.name,''), COALESCE(p.code,''),
		       COALESCE(o.estimated_value, 0), COALESCE(o.currency,'NGN'),
		       (SELECT COUNT(*) FROM milestones mm WHERE mm.project_id=p.id) AS milestone_count
		FROM milestones m
		JOIN projects p ON p.id = m.project_id AND p.deleted_at IS NULL AND p.tenant_id=$1
		LEFT JOIN opportunities o ON o.id = p.opportunity_id
		WHERE m.status IN ('done','completed','complete')
		  AND NOT EXISTS (
		      SELECT 1 FROM invoices i
		      WHERE i.milestone_id = m.id AND i.tenant_id=$1 AND i.deleted_at IS NULL
		  )
		ORDER BY m.due_on NULLS LAST LIMIT 50`, tid)
	if err == nil {
		for mrows.Next() {
			var (
				mid, projectID                  uuid.UUID
				title, projectName, code, ccy   string
				dueOn                           *time.Time
				oppValue                        float64
				milestoneCount                  int
			)
			if err := mrows.Scan(&mid, &title, &dueOn, &projectID, &projectName, &code, &oppValue, &ccy, &milestoneCount); err == nil {
				// Suggest a per-milestone slice of the opportunity value.
				suggested := 0.0
				if milestoneCount > 0 { suggested = oppValue / float64(milestoneCount) }
				out = append(out, gin.H{
					"kind":             "milestone",
					"id":               mid,
					"title":            title,
					"suggested_amount": suggested,
					"currency":         ccy,
					"project_id":       projectID,
					"project_name":     projectName,
					"project_code":     code,
					"due_on":           dueOn,
					"reason":           "Milestone delivered — bill it",
					"existing_invoices": 0,
				})
			}
		}
		mrows.Close()
	}

	c.JSON(200, gin.H{"items": out})
}

// UpdateInvoiceStatus moves an invoice between draft / issued / void.
// Status transitions to 'paid' / 'partially_paid' happen via RecordPayment.
func (h *Finance) UpdateInvoiceStatus(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }
	var req struct {
		Status   string `json:"status" binding:"required"`
		IssuedOn string `json:"issued_on"`
		DueOn    string `json:"due_on"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }

	// Hard-allow only manual transitions. Paid statuses are derived from payments.
	if req.Status != "draft" && req.Status != "issued" && req.Status != "void" {
		c.JSON(400, gin.H{"error": "status must be draft, issued or void"})
		return
	}
	// When issuing, default issued_on to today if not supplied.
	args := []any{req.Status, id, tid}
	q := "UPDATE invoices SET status=$1, updated_at=now()"
	if req.Status == "issued" {
		q = "UPDATE invoices SET status=$1, updated_at=now(), issued_on=COALESCE(issued_on, current_date)"
		if req.DueOn != "" {
			args = []any{req.Status, req.DueOn, id, tid}
			q = "UPDATE invoices SET status=$1, due_on=NULLIF($2,'')::date, updated_at=now(), issued_on=COALESCE(issued_on, current_date)"
		}
	}
	q += " WHERE id=$" + strconvItoa(len(args)-1) + " AND tenant_id=$" + strconvItoa(len(args)) + " AND deleted_at IS NULL"
	if _, err := h.db.Exec(c, q, args...); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// strconvItoa is a tiny shim so we don't have to import strconv just for $N.
func strconvItoa(n int) string {
	if n < 10 { return string(rune('0' + n)) }
	if n < 100 { return string(rune('0'+n/10)) + string(rune('0'+n%10)) }
	return ""
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
