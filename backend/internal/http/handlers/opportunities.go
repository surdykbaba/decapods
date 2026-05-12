package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/decapods/pgdp/backend/internal/governance"
	"github.com/decapods/pgdp/backend/internal/notifications"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Per-document upload cap. 25MB matches projects.Upload — keeps DB rows
// sane and lines up with what Cloudflare's free tier passes through.
const oppDocMaxBytes = 25 * 1024 * 1024

type Opportunities struct {
	db     *pgxpool.Pool
	gov    *governance.Engine
	notify *notifications.Engine
}

func NewOpportunities(db *pgxpool.Pool) *Opportunities {
	return &Opportunities{db: db, gov: governance.New(db)}
}

// WithEngine attaches the email-sending notification engine. Optional —
// without it, in-app notifications still fire and the API works fine.
func (h *Opportunities) WithEngine(engine *notifications.Engine) *Opportunities {
	h.notify = engine
	return h
}

// opportunityStakeholderRecipients pulls the creator + business lead of an
// opportunity. Used to email the people who care about a transition outcome
// (approve/reject/convert) without spamming the whole tenant.
func opportunityStakeholderRecipients(ctx context.Context, db *pgxpool.Pool, oppID uuid.UUID) []notifications.Recipient {
	out := []notifications.Recipient{}
	rows, err := db.Query(ctx, `
		SELECT DISTINCT u.id
		FROM opportunities o
		JOIN users u ON u.id IN (o.created_by, o.business_lead_id)
		WHERE o.id = $1 AND u.deleted_at IS NULL`, oppID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			out = append(out, notifications.Recipient{UserID: &id})
		}
	}
	return out
}

type createOppReq struct {
	ClientID            uuid.UUID      `json:"client_id"`
	ClientName          string         `json:"client_name"`
	Title               string         `json:"title" binding:"required,max=225"`
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
	Currency            string         `json:"currency"`
	TeamComposition     []map[string]any `json:"team_composition"`
}

func (h *Opportunities) List(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	roles, _ := c.Get(mw.CtxRoles)
	rs, _ := roles.([]string)

	// Hide opportunities whose project has been archived. Once a project is
	// soft-deleted via /projects/:id/archive, the linked opp shouldn't keep
	// rendering in the pipeline — the user already filed the work as done.
	// Opportunities with no project yet (early stages) are unaffected by
	// this filter because the NOT EXISTS only matches when a row exists.
	rows, err := h.db.Query(c, `
		SELECT o.id, o.title, o.stage, o.lead_type, o.estimated_value, o.priority,
		       o.risk_level, o.created_at, o.updated_at,
		       COALESCE(c.name, '') AS client_name,
		       (SELECT COUNT(*) FROM opportunity_documents d WHERE d.opportunity_id = o.id) AS doc_count
		FROM opportunities o
		LEFT JOIN clients c ON c.id = o.client_id
		WHERE o.tenant_id = $1 AND o.deleted_at IS NULL
		  AND NOT EXISTS (
		    SELECT 1 FROM projects p
		     WHERE p.opportunity_id = o.id
		       AND p.tenant_id      = o.tenant_id
		       AND p.deleted_at IS NOT NULL
		  )
		ORDER BY o.updated_at DESC LIMIT 200`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	wf, _ := governance.LoadWorkflow(c, h.db, tid)

	out := []map[string]any{}
	for rows.Next() {
		var (
			id                                       uuid.UUID
			title, stage, leadType, risk, clientName string
			est                                      float64
			prio, docCount                           int
			created, updated                         any
		)
		if err := rows.Scan(&id, &title, &stage, &leadType, &est, &prio, &risk, &created, &updated, &clientName, &docCount); err != nil {
			continue
		}
		required := governance.RequiredDocsFor(leadType, est)
		next := wf.AllowedTransitions(stage, rs)
		out = append(out, gin.H{
			"id": id, "title": title, "stage": stage, "lead_type": leadType,
			"estimated_value": est, "priority": prio, "risk_level": risk,
			"created_at": created, "updated_at": updated,
			"client_name":         clientName,
			"docs_attached":       docCount,
			"docs_required":       len(required),
			"next_stages":         next,
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

	if req.ClientID == uuid.Nil {
		name := req.ClientName
		if name == "" {
			name = "Default " + req.LeadType + " client"
		}
		var existing uuid.UUID
		err := h.db.QueryRow(c, `SELECT id FROM clients WHERE tenant_id=$1 AND name=$2 AND deleted_at IS NULL LIMIT 1`, tid, name).Scan(&existing)
		if err == nil {
			req.ClientID = existing
		} else {
			req.ClientID = uuid.New()
			if _, err := h.db.Exec(c, `INSERT INTO clients (id, tenant_id, name, kind) VALUES ($1,$2,$3,$4)`, req.ClientID, tid, name, req.LeadType); err != nil {
				c.JSON(500, gin.H{"error": "create client: " + err.Error()})
				return
			}
		}
	}

	if req.Metadata == nil {
		req.Metadata = map[string]any{}
	}
	if req.Dependencies == nil {
		req.Dependencies = []string{}
	}
	if req.ComplianceTags == nil {
		req.ComplianceTags = []string{}
	}

	var leadPtr *uuid.UUID
	if req.BusinessLeadID != uuid.Nil {
		leadPtr = &req.BusinessLeadID
	}
	if req.Currency == "" {
		req.Currency = "NGN"
	}
	if req.TeamComposition == nil {
		req.TeamComposition = []map[string]any{}
	}
	teamJSON, _ := json.Marshal(req.TeamComposition)

	id := uuid.New()
	_, err := h.db.Exec(c, `
		INSERT INTO opportunities
		(id, tenant_id, client_id, title, lead_type, source, category, estimated_value,
		 budget, priority, risk_level, delivery_deadline, business_lead_id,
		 technical_scope, proposal_summary, expected_manpower, dependencies,
		 compliance_tags, metadata, stage, created_by, currency, team_composition)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULLIF($12,'')::date,$13,$14,$15,$16,$17,$18,$19,'new_request',$20,$21,$22)`,
		id, tid, req.ClientID, req.Title, req.LeadType, req.Source, req.Category,
		req.EstimatedValue, req.Budget, req.Priority, req.RiskLevel,
		req.DeliveryDeadline, leadPtr, req.TechnicalScope, req.ProposalSummary,
		req.ExpectedManpower, req.Dependencies, req.ComplianceTags, req.Metadata, uid,
		req.Currency, teamJSON)
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
		       technical_scope, proposal_summary, metadata,
		       COALESCE(currency,'USD'), COALESCE(team_composition,'[]'::jsonb),
		       COALESCE(compliance_tags,'{}'::text[]), COALESCE(delivery_deadline::text,'')
		FROM opportunities WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tid)
	var (
		oid                                            uuid.UUID
		title, stage, leadType, risk, scope, proposal  string
		est, budget                                    float64
		prio                                           int
		md                                             map[string]any
		currency, deadline                             string
		teamComp                                       []map[string]any
		complianceTags                                 []string
	)
	if err := row.Scan(&oid, &title, &stage, &leadType, &est, &budget, &prio, &risk, &scope, &proposal, &md,
		&currency, &teamComp, &complianceTags, &deadline); err != nil {
		c.JSON(404, gin.H{"error": "not found"})
		return
	}
	docs := []gin.H{}
	docRows, derr := h.db.Query(c, `SELECT id, kind, name, object_key, uploaded_at FROM opportunity_documents WHERE opportunity_id=$1 ORDER BY uploaded_at DESC`, oid)
	if derr == nil {
		defer docRows.Close()
		for docRows.Next() {
			var (
				did                  uuid.UUID
				kind, name, objKey   string
				uploaded             any
			)
			if err := docRows.Scan(&did, &kind, &name, &objKey, &uploaded); err == nil {
				docs = append(docs, gin.H{
					"id": did, "kind": kind, "name": name,
					"object_key":  objKey,
					"uploaded_at": uploaded,
				})
			}
		}
	}
	roles, _ := c.Get(mw.CtxRoles)
	rs, _ := roles.([]string)
	wf, _ := governance.LoadWorkflow(c, h.db, tid)
	next := wf.AllowedTransitions(stage, rs)

	var projectID *uuid.UUID
	var pid uuid.UUID
	if err := h.db.QueryRow(c, `SELECT id FROM projects WHERE opportunity_id=$1 AND deleted_at IS NULL LIMIT 1`, oid).Scan(&pid); err == nil {
		projectID = &pid
	}

	c.JSON(200, gin.H{
		"id": oid, "title": title, "stage": stage, "lead_type": leadType,
		"estimated_value": est, "budget": budget, "priority": prio,
		"risk_level": risk, "technical_scope": scope, "proposal_summary": proposal,
		"metadata": md,
		"documents": docs,
		"required_documents": governance.RequiredDocsFor(leadType, est),
		"next_stages":        next,
		"project_id":         projectID,
		"currency":           currency,
		"team_composition":   teamComp,
		"compliance_tags":    complianceTags,
		"delivery_deadline":  deadline,
	})
}

type updateOppReq struct {
	Title             *string         `json:"title"             binding:"omitempty,max=225"`
	Source            *string         `json:"source"`
	Category          *string         `json:"category"`
	LeadType          *string         `json:"lead_type"         binding:"omitempty,oneof=government private foreign ngo internal"`
	EstimatedValue    *float64        `json:"estimated_value"`
	Budget            *float64        `json:"budget"`
	Priority          *int            `json:"priority"`
	RiskLevel         *string         `json:"risk_level"`
	DeliveryDeadline  *string         `json:"delivery_deadline"`
	TechnicalScope    *string         `json:"technical_scope"`
	ProposalSummary   *string         `json:"proposal_summary"`
	ExpectedManpower  *int            `json:"expected_manpower"`
	Dependencies      *[]string       `json:"dependencies"`
	ComplianceTags    *[]string       `json:"compliance_tags"`
	Currency          *string         `json:"currency"`
	TeamComposition   *[]map[string]any `json:"team_composition"`
	Reason            string          `json:"reason"`
}

// Update applies a partial edit to an opportunity. Stage can't be changed here —
// use /transition for that.
func (h *Opportunities) Update(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	var req updateOppReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)

	// Snapshot current values for the columns being touched so we can record
	// a "from → to" change-log entry alongside the update.
	type currentRow struct {
		Title, Source, Category, LeadType, RiskLevel, TechnicalScope, ProposalSummary, Currency string
		EstimatedValue, Budget                                                                  float64
		Priority, ExpectedManpower                                                              int
		DeliveryDeadline                                                                        *time.Time
		Dependencies, ComplianceTags                                                            []string
		TeamComposition                                                                          []byte
	}
	var cur currentRow
	if err := h.db.QueryRow(c, `
		SELECT title, COALESCE(source,''), COALESCE(category,''), lead_type,
		       risk_level, COALESCE(technical_scope,''), COALESCE(proposal_summary,''),
		       currency, estimated_value, budget, priority, expected_manpower,
		       delivery_deadline,
		       COALESCE(dependencies, '{}'), COALESCE(compliance_tags, '{}'),
		       COALESCE(team_composition::text::bytea, ''::bytea)
		FROM opportunities WHERE id=$1 AND tenant_id=$2`, id, tid).Scan(
		&cur.Title, &cur.Source, &cur.Category, &cur.LeadType,
		&cur.RiskLevel, &cur.TechnicalScope, &cur.ProposalSummary,
		&cur.Currency, &cur.EstimatedValue, &cur.Budget, &cur.Priority, &cur.ExpectedManpower,
		&cur.DeliveryDeadline, &cur.Dependencies, &cur.ComplianceTags, &cur.TeamComposition,
	); err != nil {
		c.JSON(404, gin.H{"error": "not found"})
		return
	}

	type fieldChange struct {
		Field string `json:"field"`
		From  any    `json:"from"`
		To    any    `json:"to"`
	}
	changes := []fieldChange{}
	maybe := func(field string, from, to any) {
		if fmt.Sprintf("%v", from) == fmt.Sprintf("%v", to) {
			return
		}
		changes = append(changes, fieldChange{Field: field, From: from, To: to})
	}

	// Build a dynamic UPDATE so we only touch the columns the caller actually sent.
	sets := []string{}
	args := []any{}
	add := func(col string, val any) {
		args = append(args, val)
		sets = append(sets, col+"=$"+strconv.Itoa(len(args)))
	}
	if req.Title != nil {
		next := strings.TrimSpace(*req.Title)
		maybe("title", cur.Title, next)
		add("title", next)
	}
	if req.Source != nil          { maybe("source",          cur.Source,          *req.Source);          add("source", *req.Source) }
	if req.Category != nil        { maybe("category",        cur.Category,        *req.Category);        add("category", *req.Category) }
	if req.LeadType != nil        { maybe("lead_type",       cur.LeadType,        *req.LeadType);        add("lead_type", *req.LeadType) }
	if req.EstimatedValue != nil  { maybe("estimated_value", cur.EstimatedValue,  *req.EstimatedValue);  add("estimated_value", *req.EstimatedValue) }
	if req.Budget != nil          { maybe("budget",          cur.Budget,          *req.Budget);          add("budget", *req.Budget) }
	if req.Priority != nil        { maybe("priority",        cur.Priority,        *req.Priority);        add("priority", *req.Priority) }
	if req.RiskLevel != nil       { maybe("risk_level",      cur.RiskLevel,       *req.RiskLevel);       add("risk_level", *req.RiskLevel) }
	if req.DeliveryDeadline != nil {
		v := strings.TrimSpace(*req.DeliveryDeadline)
		curDeadline := ""
		if cur.DeliveryDeadline != nil {
			curDeadline = cur.DeliveryDeadline.Format("2006-01-02")
		}
		maybe("delivery_deadline", curDeadline, v)
		args = append(args, v)
		sets = append(sets, "delivery_deadline=NULLIF($"+strconv.Itoa(len(args))+",'')::date")
	}
	if req.TechnicalScope != nil  { maybe("technical_scope",  cur.TechnicalScope,  *req.TechnicalScope);  add("technical_scope", *req.TechnicalScope) }
	if req.ProposalSummary != nil { maybe("proposal_summary", cur.ProposalSummary, *req.ProposalSummary); add("proposal_summary", *req.ProposalSummary) }
	if req.ExpectedManpower != nil { maybe("expected_manpower", cur.ExpectedManpower, *req.ExpectedManpower); add("expected_manpower", *req.ExpectedManpower) }
	if req.Dependencies != nil    {
		maybe("dependencies", strings.Join(cur.Dependencies, ", "), strings.Join(*req.Dependencies, ", "))
		add("dependencies", *req.Dependencies)
	}
	if req.ComplianceTags != nil  {
		maybe("compliance_tags", strings.Join(cur.ComplianceTags, ", "), strings.Join(*req.ComplianceTags, ", "))
		add("compliance_tags", *req.ComplianceTags)
	}
	if req.Currency != nil        { maybe("currency", cur.Currency, *req.Currency); add("currency", *req.Currency) }
	if req.TeamComposition != nil {
		teamJSON, _ := json.Marshal(*req.TeamComposition)
		curTeam := string(cur.TeamComposition)
		newTeam := string(teamJSON)
		if curTeam != newTeam {
			changes = append(changes, fieldChange{Field: "team_composition", From: curTeam, To: newTeam})
		}
		add("team_composition", teamJSON)
	}

	if len(sets) == 0 {
		c.JSON(400, gin.H{"error": "no fields to update"})
		return
	}
	sets = append(sets, "updated_at=now()")
	args = append(args, id, tid)

	q := "UPDATE opportunities SET " + strings.Join(sets, ", ") +
		" WHERE id=$" + strconv.Itoa(len(args)-1) +
		" AND tenant_id=$" + strconv.Itoa(len(args))
	if _, err := h.db.Exec(c, q, args...); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Append the change-log entry to metadata.change_history.
	if len(changes) > 0 {
		entry := map[string]any{
			"at":      time.Now().UTC().Format(time.RFC3339),
			"by":      uid,
			"reason":  strings.TrimSpace(req.Reason),
			"changes": changes,
		}
		entryJSON, _ := json.Marshal(entry)
		if _, err := h.db.Exec(c, `
			UPDATE opportunities
			SET metadata = jsonb_set(
			  COALESCE(metadata, '{}'::jsonb),
			  '{change_history}',
			  COALESCE(metadata->'change_history', '[]'::jsonb) || $1::jsonb,
			  true
			)
			WHERE id=$2`, entryJSON, id); err != nil {
			c.Header("X-History-Warning", err.Error())
		}
	}

	c.JSON(200, gin.H{"ok": true, "changes": changes})
}

// Delete soft-deletes an opportunity. Refuses if the lifecycle has reached the
// terminal "closed" stage (closed work is preserved as audit history) or if a
// live project has been spawned from it (would orphan the project lookup).
// Anything still in pre-delivery / delivery / invoiced is fair game.
func (h *Opportunities) Delete(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	// Look up current state — must exist, not already deleted, not closed.
	var stage string
	err = h.db.QueryRow(c,
		`SELECT stage FROM opportunities WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`,
		id, tid).Scan(&stage)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "opportunity not found"})
		return
	}
	if stage == "closed" {
		c.JSON(http.StatusConflict, gin.H{
			"error": "Closed opportunities cannot be deleted — they are kept as completion history.",
			"code":  "stage_closed",
		})
		return
	}

	// Block if there's a live project spun off from this opportunity.
	var projectID uuid.UUID
	if err := h.db.QueryRow(c,
		`SELECT id FROM projects WHERE opportunity_id=$1 AND deleted_at IS NULL LIMIT 1`,
		id).Scan(&projectID); err == nil {
		c.JSON(http.StatusConflict, gin.H{
			"error": "A project has already been spawned from this opportunity. Archive the project first.",
			"code":  "project_exists",
			"project_id": projectID.String(),
		})
		return
	}

	if _, err := h.db.Exec(c,
		`UPDATE opportunities SET deleted_at=now(), updated_at=now()
		 WHERE id=$1 AND tenant_id=$2`, id, tid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
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

	// Notify reviewers that something is waiting for them.
	var oppTitle string
	_ = h.db.QueryRow(c, `SELECT title FROM opportunities WHERE id=$1`, id).Scan(&oppTitle)
	rcpts := notifications.Recipients(c, h.db, tid)
	_ = notifications.Notify(c, h.db, tid, rcpts, notifications.N{
		Kind:  "opportunity.submitted",
		Title: "New opportunity awaiting review",
		Body:  oppTitle + " has been submitted for review.",
		Link:  "/pipeline/" + id.String(),
	})

	// Email — engine respects per-user preferences.
	if h.notify != nil {
		emailRcpts := h.notify.RecipientsByRole(c, tid, "ceo", "compliance_officer", "super_admin")
		h.notify.Notify(c, notifications.Event{
			Kind:       "opportunity.review_requested",
			TenantID:   tid,
			Recipients: emailRcpts,
			Payload:    map[string]any{"Title": oppTitle},
			Link:       "/pipeline/" + id.String(),
			DedupeKey:  "opportunity.review_requested:" + id.String(),
		})
	}

	c.JSON(200, gin.H{"ok": true, "stage": "under_review"})
}

func (h *Opportunities) Transition(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	var req struct {
		To     string `json:"to" binding:"required"`
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	roles, _ := c.Get(mw.CtxRoles)
	rs, _ := roles.([]string)

	var current string
	if err := h.db.QueryRow(c, `SELECT stage FROM opportunities WHERE id=$1 AND tenant_id=$2`, id, tid).Scan(&current); err != nil {
		c.JSON(404, gin.H{"error": "not found"})
		return
	}

	wf, err := governance.LoadWorkflow(c, h.db, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": "workflow load: " + err.Error()})
		return
	}
	if !wf.CanTransition(current, req.To, rs) {
		c.JSON(403, gin.H{
			"error": "transition not allowed for your role",
			"from":  current,
			"to":    req.To,
		})
		return
	}

	// Gate the terminal `closed` transition on commercial receipts. We refuse
	// to close anything that doesn't carry an Invoice + PaymentReceipt because
	// the org will need them for audit later and chasing them up after the
	// fact is a nightmare.
	if req.To == "closed" {
		eng := governance.New(h.db)
		dec := eng.EvaluateOpportunityClosing(c.Request.Context(), id)
		if !dec.Allow {
			c.JSON(422, gin.H{
				"error":      "cannot close — required commercial documents are missing",
				"code":       "missing_closing_documents",
				"violations": dec.Violations,
			})
			return
		}
	}

	if _, err := h.db.Exec(c, `UPDATE opportunities SET stage=$1, updated_at=now() WHERE id=$2`, req.To, id); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Stage sync — Pipeline is the source of truth for an engagement's
	// lifecycle. The project mirrors every post-planning stage so the
	// Projects list, dashboards, and closure rules stay in lockstep.
	// Without this, projects got stuck at "planning" forever because no
	// handler ever updated their status after creation.
	if projectStageSyncable(req.To) {
		if _, err := h.db.Exec(c, `
			UPDATE projects
			   SET status=$1, updated_at=now()
			 WHERE opportunity_id=$2 AND tenant_id=$3 AND deleted_at IS NULL`,
			req.To, id, tid); err != nil {
			// Non-fatal — opp moved, but we lost the mirror. Surface via
			// response header so support can reconcile after the fact.
			c.Header("X-Project-Sync-Warning", err.Error())
		}
	}

	// Convert opportunity to a project the moment it hits "planning".
	// Idempotent — only creates one project per opportunity.
	var convertedProjectID *uuid.UUID
	if req.To == "planning" {
		if pid, err := h.convertToProject(c, tid, id, uid); err != nil {
			c.Header("X-Project-Conversion-Warning", err.Error())
		} else if pid != uuid.Nil {
			convertedProjectID = &pid
		}
	}

	// Append to stage history in metadata.
	entry := map[string]any{
		"at":     time.Now().UTC().Format(time.RFC3339),
		"by":     uid,
		"from":   current,
		"to":     req.To,
		"reason": req.Reason,
	}
	entryJSON, _ := json.Marshal(entry)
	if _, err := h.db.Exec(c, `
		UPDATE opportunities
		SET metadata = jsonb_set(
		  COALESCE(metadata, '{}'::jsonb),
		  '{stage_history}',
		  COALESCE(metadata->'stage_history', '[]'::jsonb) || $1::jsonb,
		  true
		)
		WHERE id=$2`, entryJSON, id); err != nil {
		// Non-fatal — the transition itself succeeded.
		c.Header("X-History-Warning", err.Error())
	}

	// Notifications for the transition.
	var oppTitle string
	_ = h.db.QueryRow(c, `SELECT title FROM opportunities WHERE id=$1`, id).Scan(&oppTitle)
	rcpts := notifications.Recipients(c, h.db, tid, uid)

	if isBackwardStage(current, req.To) {
		body := oppTitle + " was sent back to " + req.To
		if req.Reason != "" {
			body += ` — "` + req.Reason + `"`
		}
		_ = notifications.Notify(c, h.db, tid, rcpts, notifications.N{
			Kind:  "opportunity.rejected",
			Title: "Opportunity rejected",
			Body:  body,
			Link:  "/pipeline/" + id.String(),
		})
		// Email the lead's creator + business lead.
		if h.notify != nil {
			h.notify.Notify(c, notifications.Event{
				Kind:       "opportunity.rejected",
				TenantID:   tid,
				Recipients: opportunityStakeholderRecipients(c, h.db, id),
				Payload:    map[string]any{"Title": oppTitle, "Reason": req.Reason, "BackTo": req.To},
				Link:       "/pipeline/" + id.String(),
				DedupeKey:  "opportunity.rejected:" + id.String() + ":" + req.To,
			})
		}
	} else if convertedProjectID != nil {
		_ = notifications.Notify(c, h.db, tid, rcpts, notifications.N{
			Kind:  "opportunity.converted",
			Title: "Project created",
			Body:  oppTitle + " entered planning — a delivery project was created.",
			Link:  "/projects/" + convertedProjectID.String(),
		})
		if h.notify != nil {
			h.notify.Notify(c, notifications.Event{
				Kind:       "opportunity.converted",
				TenantID:   tid,
				Recipients: opportunityStakeholderRecipients(c, h.db, id),
				Payload:    map[string]any{"Title": oppTitle},
				Link:       "/projects/" + convertedProjectID.String(),
				DedupeKey:  "opportunity.converted:" + id.String(),
			})
		}
	} else {
		_ = notifications.Notify(c, h.db, tid, rcpts, notifications.N{
			Kind:  "opportunity.transitioned",
			Title: "Stage changed",
			Body:  oppTitle + " moved to " + req.To,
			Link:  "/pipeline/" + id.String(),
		})
		// "Approved" is the canonical email-worthy moment when moving forward.
		if req.To == "approved" && h.notify != nil {
			h.notify.Notify(c, notifications.Event{
				Kind:       "opportunity.approved",
				TenantID:   tid,
				Recipients: opportunityStakeholderRecipients(c, h.db, id),
				Payload:    map[string]any{"Title": oppTitle},
				Link:       "/pipeline/" + id.String(),
				DedupeKey:  "opportunity.approved:" + id.String(),
			})
		}
	}

	resp := gin.H{"ok": true, "stage": req.To}
	if convertedProjectID != nil {
		resp["project_id"] = convertedProjectID
		resp["converted_to_project"] = true
	}
	c.JSON(200, resp)
}

// projectStageSyncable — the subset of Pipeline stages that correspond to a
// project's lifecycle. Pre-project stages (new_request, under_review,
// approved, contracting) are intentionally NOT mirrored because the project
// row doesn't exist yet. The "planning" stage is excluded too: convertToProject
// already inserts the project with status='planning' on first transition, so
// re-stamping it on every back-and-forth is noise.
func projectStageSyncable(stage string) bool {
	switch stage {
	case "in_progress", "qa_review", "client_acceptance", "invoiced", "paid", "closed":
		return true
	}
	return false
}

// isBackwardStage tells us if `to` is upstream of `from` in the lifecycle.
func isBackwardStage(from, to string) bool {
	order := map[string]int{
		"new_request": 0, "under_review": 1, "approved": 2, "contracting": 3,
		"planning": 4, "in_progress": 5, "qa_review": 6, "client_acceptance": 7,
		"invoiced": 8, "paid": 9, "closed": 10,
	}
	a, ok1 := order[from]
	b, ok2 := order[to]
	return ok1 && ok2 && b < a
}

// convertToProject creates a project record for an opportunity that's reached
// the planning stage, copies stakeholders across, and seeds a project code.
// Returns uuid.Nil if a project already exists for this opportunity.
func (h *Opportunities) convertToProject(c *gin.Context, tid, oppID, uid uuid.UUID) (uuid.UUID, error) {
	var existing uuid.UUID
	if err := h.db.QueryRow(c, `SELECT id FROM projects WHERE opportunity_id=$1 AND deleted_at IS NULL LIMIT 1`, oppID).Scan(&existing); err == nil {
		return uuid.Nil, nil
	}

	var (
		title, leadType, ccy string
		clientID             uuid.UUID
		est, budget          float64
		prio                 int
	)
	if err := h.db.QueryRow(c, `
		SELECT title, lead_type, client_id, estimated_value, COALESCE(budget,0), priority, COALESCE(currency,'USD')
		FROM opportunities WHERE id=$1 AND tenant_id=$2`, oppID, tid).
		Scan(&title, &leadType, &clientID, &est, &budget, &prio, &ccy); err != nil {
		return uuid.Nil, err
	}

	// Generate a unique project code: PRJ-NNNN per tenant.
	var nextSeq int
	_ = h.db.QueryRow(c, `
		SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\D', '', 'g'), '')::int), 0) + 1
		FROM projects WHERE tenant_id=$1`, tid).Scan(&nextSeq)
	code := fmt.Sprintf("PRJ-%04d", nextSeq)
	if len(ccy) > 3 {
		ccy = ccy[:3]
	}

	pid := uuid.New()
	if _, err := h.db.Exec(c, `
		INSERT INTO projects (id, tenant_id, opportunity_id, client_id, code, name, status, priority, budget_amount, currency, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, 'planning', $7, $8, $9, $10)`,
		pid, tid, oppID, clientID, code, title, prio, budget, ccy, uid); err != nil {
		return uuid.Nil, err
	}

	// Copy stakeholders across so the delivery team starts with the same context.
	if _, err := h.db.Exec(c, `
		INSERT INTO stakeholders (id, tenant_id, entity_type, entity_id, name, role, kind, email, phone, notes, created_by)
		SELECT gen_random_uuid(), tenant_id, 'project', $1, name, role, kind, email, phone, notes, created_by
		FROM stakeholders WHERE entity_type='opportunity' AND entity_id=$2 AND tenant_id=$3`,
		pid, oppID, tid); err != nil {
		// Non-fatal — project still created.
		c.Header("X-Stakeholder-Copy-Warning", err.Error())
	}

	_ = est // referenced for future use
	return pid, nil
}

// UploadDocument — POST /api/v1/opportunities/:id/documents/upload
// multipart/form-data { file, kind, name? }
//
// Stores the file inline in opportunity_documents.bytes so the previewer
// can serve it back via DownloadDocument. object_key is set to a stable
// internal scheme (doc://<docId>) the frontend resolves to the download
// endpoint. Replaces the old "fake local:// pointer" stub.
func (h *Opportunities) UploadDocument(c *gin.Context) {
	oid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad opportunity id"})
		return
	}
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)

	// Cap the body before the multipart parser allocates against it.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, oppDocMaxBytes+1024*1024)
	if err := c.Request.ParseMultipartForm(32 << 20); err != nil {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "upload too large (max 25MB)"})
		return
	}
	fh, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing file"})
		return
	}
	if fh.Size > oppDocMaxBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "file exceeds 25MB cap"})
		return
	}

	kind := strings.TrimSpace(c.PostForm("kind"))
	if kind == "" {
		kind = "other"
	}
	name := strings.TrimSpace(c.PostForm("name"))
	if name == "" {
		name = fh.Filename
	}
	contentType := fh.Header.Get("Content-Type")

	f, err := fh.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not read upload"})
		return
	}
	defer f.Close()
	bytes, err := io.ReadAll(f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not read upload bytes"})
		return
	}

	// Verify the opportunity exists in this tenant before writing.
	var ownerTid uuid.UUID
	if err := h.db.QueryRow(c, `SELECT tenant_id FROM opportunities WHERE id=$1 AND deleted_at IS NULL`, oid).
		Scan(&ownerTid); err != nil || ownerTid != tid {
		c.JSON(http.StatusNotFound, gin.H{"error": "opportunity not found"})
		return
	}

	docID := uuid.New()
	objKey := "doc://" + docID.String()
	if _, err := h.db.Exec(c, `
		INSERT INTO opportunity_documents
		  (id, opportunity_id, tenant_id, kind, name, object_key,
		   content_type, size_bytes, bytes, uploaded_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		docID, oid, tid, kind, name, objKey, contentType, len(bytes), bytes, uid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id":           docID,
		"object_key":   objKey,
		"name":         name,
		"kind":         kind,
		"content_type": contentType,
		"size_bytes":   len(bytes),
	})
}

// DownloadDocument — GET /api/v1/opportunities/:id/documents/:docId/content
//
// Streams the stored binary back with the right Content-Type so the
// browser can preview / download it. Authenticated by the standard
// middleware; tenant_id check prevents cross-tenant fetches.
func (h *Opportunities) DownloadDocument(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	oid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad opportunity id"})
		return
	}
	docID, err := uuid.Parse(c.Param("docId"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad document id"})
		return
	}
	var (
		name, contentType string
		bytes             []byte
	)
	if err := h.db.QueryRow(c, `
		SELECT name, COALESCE(content_type, 'application/octet-stream'), bytes
		  FROM opportunity_documents
		 WHERE id=$1 AND opportunity_id=$2 AND tenant_id=$3`,
		docID, oid, tid).Scan(&name, &contentType, &bytes); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "document not found"})
		return
	}
	if len(bytes) == 0 {
		c.JSON(http.StatusGone, gin.H{"error": "document body not stored (legacy local:// pointer)"})
		return
	}
	c.Header("Content-Disposition", `inline; filename="`+strings.ReplaceAll(name, `"`, "")+`"`)
	c.Data(http.StatusOK, contentType, bytes)
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
