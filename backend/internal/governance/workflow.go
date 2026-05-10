package governance

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Transition represents one allowed move between two opportunity stages.
type Transition struct {
	From  string   `json:"from"`
	To    string   `json:"to"`
	Label string   `json:"label,omitempty"`
	Roles []string `json:"roles,omitempty"` // empty = any user with opportunity:write
}

// Workflow is the editable per-tenant lifecycle definition.
type Workflow struct {
	Transitions []Transition `json:"transitions"`
}

// DefaultWorkflow is used when a tenant has no custom workflow saved.
func DefaultWorkflow() Workflow {
	reviewers := []string{"ceo", "compliance_officer", "super_admin"}
	return Workflow{
		Transitions: []Transition{
			// Forward
			{From: "under_review",      To: "approved",          Label: "Approve",            Roles: reviewers},
			{From: "approved",          To: "contracting",       Label: "Move to contracting"},
			{From: "contracting",       To: "planning",          Label: "Move to planning"},
			{From: "planning",          To: "in_progress",       Label: "Start delivery"},
			{From: "in_progress",       To: "qa_review",         Label: "Send to QA"},
			{From: "qa_review",         To: "client_acceptance", Label: "Pass to client"},
			{From: "client_acceptance", To: "invoiced",          Label: "Mark invoiced",      Roles: []string{"finance", "super_admin"}},
			{From: "invoiced",          To: "paid",              Label: "Mark paid",          Roles: []string{"finance", "super_admin"}},
			{From: "paid",              To: "closed",            Label: "Close engagement"},

			// Backwards / rejection paths — same reviewer roles can pull a card back.
			{From: "under_review",      To: "new_request",       Label: "Send back",            Roles: reviewers},
			{From: "approved",          To: "under_review",      Label: "Re-open review",       Roles: reviewers},
			{From: "contracting",       To: "under_review",      Label: "Reject to review",     Roles: reviewers},
			{From: "contracting",       To: "approved",          Label: "Back to approved"},
			{From: "planning",          To: "under_review",      Label: "Reject to review",     Roles: reviewers},
			{From: "in_progress",       To: "under_review",      Label: "Reject to review",     Roles: reviewers},
			{From: "qa_review",         To: "in_progress",       Label: "Back to delivery"},
			{From: "qa_review",         To: "under_review",      Label: "Reject to review",     Roles: reviewers},
			{From: "client_acceptance", To: "in_progress",       Label: "Back to delivery",     Roles: reviewers},
		},
	}
}

// LoadWorkflow returns the saved workflow for a tenant, or the default if none.
func LoadWorkflow(ctx context.Context, db *pgxpool.Pool, tenantID uuid.UUID) (Workflow, error) {
	var raw []byte
	err := db.QueryRow(ctx,
		`SELECT definition FROM opportunity_workflows WHERE tenant_id=$1`, tenantID).Scan(&raw)
	if err == pgx.ErrNoRows {
		return DefaultWorkflow(), nil
	}
	if err != nil {
		return Workflow{}, err
	}
	var wf Workflow
	if err := json.Unmarshal(raw, &wf); err != nil {
		return Workflow{}, err
	}
	if len(wf.Transitions) == 0 {
		return DefaultWorkflow(), nil
	}
	return wf, nil
}

// SaveWorkflow upserts the workflow definition.
func SaveWorkflow(ctx context.Context, db *pgxpool.Pool, tenantID, userID uuid.UUID, wf Workflow) error {
	def, err := json.Marshal(wf)
	if err != nil {
		return err
	}
	_, err = db.Exec(ctx, `
		INSERT INTO opportunity_workflows (tenant_id, definition, updated_at, updated_by)
		VALUES ($1, $2, now(), $3)
		ON CONFLICT (tenant_id)
		DO UPDATE SET definition=EXCLUDED.definition, updated_at=now(), updated_by=EXCLUDED.updated_by`,
		tenantID, def, userID)
	return err
}

// AllowedTransitions returns transitions whose `from` matches the current
// stage and whose role-gating either is empty or includes one of `userRoles`.
func (w Workflow) AllowedTransitions(stage string, userRoles []string) []Transition {
	out := []Transition{}
	for _, t := range w.Transitions {
		if t.From != stage {
			continue
		}
		if len(t.Roles) == 0 || hasAnyRole(userRoles, t.Roles) {
			out = append(out, t)
		}
	}
	return out
}

// CanTransition is the strict gate used by the Transition handler.
func (w Workflow) CanTransition(from, to string, userRoles []string) bool {
	for _, t := range w.Transitions {
		if t.From == from && t.To == to {
			return len(t.Roles) == 0 || hasAnyRole(userRoles, t.Roles)
		}
	}
	return false
}

func hasAnyRole(have, want []string) bool {
	if len(have) == 0 || len(want) == 0 {
		return false
	}
	set := map[string]bool{}
	for _, r := range have {
		set[r] = true
	}
	for _, r := range want {
		if set[r] {
			return true
		}
	}
	return false
}
