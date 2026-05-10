// Package governance is the configurable rule engine that gates state
// transitions across the platform.
package governance

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Decision struct {
	Allow      bool        `json:"allow"`
	Violations []Violation `json:"violations"`
}

type Violation struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Field   string `json:"field,omitempty"`
}

type Engine struct {
	db *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Engine { return &Engine{db: db} }

// EvaluateOpportunitySubmission runs the gating checks before an opportunity
// is allowed to move from `new_request` to `under_review`.
func (e *Engine) EvaluateOpportunitySubmission(ctx context.Context, tenantID, oppID uuid.UUID) Decision {
	d := Decision{Allow: true}
	var (
		leadType string
		est      float64
	)
	if err := e.db.QueryRow(ctx, `SELECT lead_type, estimated_value FROM opportunities WHERE id=$1`, oppID).
		Scan(&leadType, &est); err != nil {
		return Decision{Allow: false, Violations: []Violation{{Code: "not_found", Message: err.Error()}}}
	}

	required := requiredDocsFor(leadType, est)
	rows, err := e.db.Query(ctx,
		`SELECT kind FROM opportunity_documents WHERE opportunity_id = $1`, oppID)
	if err != nil {
		return Decision{Allow: false, Violations: []Violation{{Code: "db", Message: err.Error()}}}
	}
	defer rows.Close()
	have := map[string]bool{}
	for rows.Next() {
		var k string
		_ = rows.Scan(&k)
		have[k] = true
	}
	for _, r := range required {
		if !have[r] {
			d.Allow = false
			d.Violations = append(d.Violations, Violation{
				Code: "missing_document", Field: r,
				Message: fmt.Sprintf("required document %q is missing", r),
			})
		}
	}

	// Tenant-level custom policies (JSON-Logic-like) layered on top.
	custRows, err := e.db.Query(ctx,
		`SELECT code, definition FROM policy_rules
		 WHERE tenant_id=$1 AND kind='opportunity_submit' AND active=true`, tenantID)
	if err == nil {
		defer custRows.Close()
		for custRows.Next() {
			var code string
			var def map[string]any
			_ = custRows.Scan(&code, &def)
			if !evalRule(def, map[string]any{"lead_type": leadType, "estimated_value": est}) {
				d.Allow = false
				d.Violations = append(d.Violations, Violation{Code: code, Message: "custom policy failed"})
			}
		}
	}
	return d
}

// RequiredDocsFor exposes the required-documents list so handlers can
// surface it in the opportunity GET response (not only at submit time).
func RequiredDocsFor(leadType string, value float64) []string {
	return requiredDocsFor(leadType, value)
}

func requiredDocsFor(leadType string, value float64) []string {
	base := []string{"NDA", "TechnicalProposal", "ScopeDocument"}
	switch leadType {
	case "government":
		base = append(base, "RFP", "ComplianceForm", "ProcurementApproval")
	case "private":
		base = append(base, "MSA")
		if value > 100_000 {
			base = append(base, "Contract")
		}
	case "foreign":
		base = append(base, "ExportComplianceForm", "FXApproval")
	case "ngo":
		base = append(base, "GrantAgreement")
	}
	return base
}

// IsValidStageTransition checks the lifecycle policy for opportunities.
func IsValidStageTransition(ctx context.Context, db *pgxpool.Pool, oppID uuid.UUID, to string) bool {
	var current string
	if err := db.QueryRow(ctx, `SELECT stage FROM opportunities WHERE id=$1`, oppID).Scan(&current); err != nil {
		return false
	}
	allowed := map[string][]string{
		"new_request":       {"under_review"},
		"under_review":      {"approved", "new_request"},
		"approved":          {"contracting"},
		"contracting":       {"planning", "approved"},
		"planning":          {"in_progress"},
		"in_progress":       {"qa_review"},
		"qa_review":         {"client_acceptance", "in_progress"},
		"client_acceptance": {"invoiced"},
		"invoiced":          {"paid"},
		"paid":              {"closed"},
	}
	for _, n := range allowed[current] {
		if n == to {
			return true
		}
	}
	return false
}
