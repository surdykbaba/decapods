package handlers

import (
	"net/http"

	"github.com/decapods/pgdp/backend/internal/governance"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Opportunities struct {
	db  *pgxpool.Pool
	gov *governance.Engine
}

func NewOpportunities(db *pgxpool.Pool) *Opportunities {
	return &Opportunities{db: db, gov: governance.New(db)}
}

type createOppReq struct {
	ClientID            uuid.UUID      `json:"client_id" binding:"required"`
	Title               string         `json:"title" binding:"required"`
	LeadType            string         `json:"lead_type" binding:"required,oneof=government private foreign ngo internal"`
	Source              string         `json:"source"`
	Category            string         `json:"category"`
	EstimatedValue      float64        `json:"estimated_value"`
	Budget              float64        `json:"budget"`
	Priority            int            `json:"priority"`
	RiskLevel           string         `json:"risk_level"`
	DeliveryDeadline    string         `json:"delivery_deadline"`
	BusinessLeadID      uuid.UUID      `json:"business_lead_id"`
	TechnicalScope      string         `json:"technical_scope"`
	ProposalSummary     string         `json:"proposal_summary"`
	ExpectedManpower    int            `json:"expected_manpower"`
	Dependencies        []string       `json:"dependencies"`
	ComplianceTags      []string       `json:"compliance_tags"`
	Metadata            map[string]any `json:"metadata"`
}

func (h *Opportunities) List(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c, `
		SELECT id, title, stage, lead_type, estimated_value, priority, risk_level, created_at
		FROM opportunities WHERE tenant_id = $1 AND deleted_at IS NULL
		ORDER BY created_at DESC LIMIT 200`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			id                              uuid.UUID
			title, stage, leadType, risk    string
			est                             float64
			prio                            int
			created                         any
		)
		if err := rows.Scan(&id, &title, &stage, &leadType, &est, &prio, &risk, &created); err != nil {
			continue
		}
		out = append(out, gin.H{
			"id": id, "title": title, "stage": stage, "lead_type": leadType,
			"estimated_value": est, "priority": prio, "risk_level": risk, "created_at": created,
		})
	}
	c.JSON(200, gin.H{"items": out})
}

func (h *Opportunities) Create(c *gin.Context) {
	var req createOppReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	id := uuid.New()
	_, err := h.db.Exec(c, `
		INSERT INTO opportunities
		(id, tenant_id, client_id, title, lead_type, source, category, estimated_value,
		 budget, priority, risk_level, delivery_deadline, business_lead_id,
		 technical_scope, proposal_summary, expected_manpower, dependencies,
		 compliance_tags, metadata, stage, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULLIF($12,'')::date,$13,$14,$15,$16,$17,$18,$19,'new_request',$20)`,
		id, tid, req.ClientID, req.Title, req.LeadType, req.Source, req.Category,
		req.EstimatedValue, req.Budget, req.Priority, req.RiskLevel,
		req.DeliveryDeadline, req.BusinessLeadID, req.TechnicalScope, req.ProposalSummary,
		req.ExpectedManpower, req.Dependencies, req.ComplianceTags, req.Metadata, uid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

func (h *Opportunities) Get(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	row := h.db.QueryRow(c, `
		SELECT id, title, stage, lead_type, estimated_value, budget, priority, risk_level,
		       technical_scope, proposal_summary, metadata
		FROM opportunities WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tid)
	var (
		oid                                            uuid.UUID
		title, stage, leadType, risk, scope, proposal  string
		est, budget                                    float64
		prio                                           int
		md                                             map[string]any
	)
	if err := row.Scan(&oid, &title, &stage, &leadType, &est, &budget, &prio, &risk, &scope, &proposal, &md); err != nil {
		c.JSON(404, gin.H{"error": "not found"})
		return
	}
	c.JSON(200, gin.H{
		"id": oid, "title": title, "stage": stage, "lead_type": leadType,
		"estimated_value": est, "budget": budget, "priority": prio,
		"risk_level": risk, "technical_scope": scope, "proposal_summary": proposal,
		"metadata": md,
	})
}

func (h *Opportunities) Submit(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	decision := h.gov.EvaluateOpportunitySubmission(c, tid, id)
	if !decision.Allow {
		c.JSON(http.StatusUnprocessableEntity, gin.H{
			"error":      "governance violations",
			"violations": decision.Violations,
		})
		return
	}
	_, _ = h.db.Exec(c, `UPDATE opportunities SET stage='under_review', updated_at=now() WHERE id=$1`, id)
	c.JSON(200, gin.H{"ok": true, "stage": "under_review"})
}

func (h *Opportunities) Transition(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	var req struct {
		To string `json:"to" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if !governance.IsValidStageTransition(c, h.db, id, req.To) {
		c.JSON(409, gin.H{"error": "invalid transition"})
		return
	}
	_, err := h.db.Exec(c, `UPDATE opportunities SET stage=$1, updated_at=now() WHERE id=$2`, req.To, id)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true, "stage": req.To})
}

func (h *Opportunities) AttachDocument(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	var req struct {
		Kind     string `json:"kind" binding:"required"`
		Name     string `json:"name" binding:"required"`
		ObjectKey string `json:"object_key" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	docID := uuid.New()
	_, err := h.db.Exec(c, `
		INSERT INTO opportunity_documents (id, opportunity_id, kind, name, object_key, uploaded_by)
		VALUES ($1,$2,$3,$4,$5,$6)`, docID, id, req.Kind, req.Name, req.ObjectKey, uid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": docID})
}
