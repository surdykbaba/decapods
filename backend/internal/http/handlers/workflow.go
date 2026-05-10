package handlers

import (
	"net/http"

	"github.com/decapods/pgdp/backend/internal/governance"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Workflows struct {
	db *pgxpool.Pool
}

func NewWorkflows(db *pgxpool.Pool) *Workflows { return &Workflows{db: db} }

// GetOpportunityWorkflow returns the saved workflow (or default).
func (h *Workflows) GetOpportunityWorkflow(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	wf, err := governance.LoadWorkflow(c, h.db, tid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	def := governance.DefaultWorkflow()
	c.JSON(http.StatusOK, gin.H{
		"workflow": wf,
		"default":  def,
		"stages":   stageList(wf, def),
		"roles": []string{
			"super_admin", "ceo", "coo", "finance", "hr",
			"business_dev", "delivery_manager", "project_manager",
			"engineer", "qa", "auditor", "compliance_officer", "client_viewer",
		},
	})
}

// PutOpportunityWorkflow upserts the workflow.
func (h *Workflows) PutOpportunityWorkflow(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var wf governance.Workflow
	if err := c.ShouldBindJSON(&wf); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	for i, t := range wf.Transitions {
		if t.From == "" || t.To == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "every transition must have a from and to", "index": i})
			return
		}
	}
	if err := governance.SaveWorkflow(c, h.db, tid, uid, wf); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// stageList collects unique stage keys present in the saved or default workflow.
func stageList(saved, def governance.Workflow) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(s string) {
		if s == "" || seen[s] {
			return
		}
		seen[s] = true
		out = append(out, s)
	}
	for _, t := range saved.Transitions {
		add(t.From); add(t.To)
	}
	for _, t := range def.Transitions {
		add(t.From); add(t.To)
	}
	add("new_request")
	return out
}
