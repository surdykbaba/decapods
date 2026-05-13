// Package projects implements the delivery module: projects, milestones,
// tasks, board view, and risk computation.
package projects

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// itoa — tiny shim so the dynamic SQL builder in List reads as one
// expression per bound arg without dragging fmt into the package.
func itoa(n int) string { return strconv.Itoa(n) }

type Service struct{ db *pgxpool.Pool }

func NewService(db *pgxpool.Pool) *Service { return &Service{db: db} }

type CreateInput struct {
	TenantID      uuid.UUID `json:"-"`
	CreatedBy     uuid.UUID `json:"-"`
	OpportunityID uuid.UUID `json:"opportunity_id"`
	ClientID      uuid.UUID `json:"client_id" binding:"required"`
	Code          string    `json:"code" binding:"required"`
	Name          string    `json:"name" binding:"required"`
	Category      string    `json:"category"`
	Priority      int       `json:"priority"`
	Budget        float64   `json:"budget"`
	Currency      string    `json:"currency"`
	StartDate     string    `json:"start_date"`
	EndDate       string    `json:"end_date"`
}

type MilestoneInput struct {
	Title       string    `json:"title" binding:"required"`
	Description string    `json:"description"`
	DueOn       string    `json:"due_on"`
	Status      string    `json:"status"`
	AssigneeID  uuid.UUID `json:"assignee_id"`
}

type TaskInput struct {
	CreatedBy   uuid.UUID `json:"-"`
	Title       string    `json:"title" binding:"required"`
	Description string    `json:"description"`
	AssigneeID  uuid.UUID `json:"assignee_id"`
	MilestoneID uuid.UUID `json:"milestone_id"`
	Status      string    `json:"status"`
	Priority    int       `json:"priority"`
	DueOn       string    `json:"due_on"`
	StartOn     string    `json:"start_on"`
}

type Project struct {
	ID        uuid.UUID `json:"id"`
	Code      string    `json:"code"`
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	Health    string    `json:"health"`
	RiskScore float64   `json:"risk_score"`
	Budget    float64   `json:"budget"`
	StartDate *time.Time `json:"start_date"`
	EndDate   *time.Time `json:"end_date"`
}

type ListItem struct {
	ID            uuid.UUID  `json:"id"`
	Code          string     `json:"code"`
	Name          string     `json:"name"`
	Status        string     `json:"status"`
	Health        string     `json:"health"`
	RiskScore     float64    `json:"risk_score"`
	Budget        float64    `json:"budget"`
	Currency      string     `json:"currency"`
	StartDate     *time.Time `json:"start_date"`
	EndDate       *time.Time `json:"end_date"`
	OpportunityID *uuid.UUID `json:"opportunity_id"`
	ClientName    string     `json:"client_name"`
	LeadType      string     `json:"lead_type"`
	UpdatedAt     time.Time  `json:"updated_at"`
	Tasks         int        `json:"tasks"`
	TasksDone     int        `json:"tasks_done"`
	Blockers      int        `json:"blockers"`
	Stakeholders  int        `json:"stakeholders"`
	Milestones    int        `json:"milestones"`
}

// List returns the projects visible to the caller. When selfOnly is true,
// the result is narrowed to projects where the caller is a current member
// (project_members row, not removed). This is how engineer / designer /
// qa / intern / client_viewer — roles whose RBAC grant is
// project:read:self — see only what they're allocated to instead of
// either nothing (403) or the whole tenant.
func (s *Service) List(ctx context.Context, tenantID, userID uuid.UUID, status string, selfOnly bool) ([]ListItem, error) {
	q := `
		SELECT
		  p.id, p.code, p.name, p.status, p.health, p.risk_score,
		  COALESCE(p.budget_amount, 0), p.currency, p.start_date, p.end_date,
		  p.opportunity_id, COALESCE(c.name, ''), COALESCE(o.lead_type, ''),
		  p.updated_at,
		  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL),
		  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.status = 'done'),
		  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.priority <= 1 AND t.status <> 'done'),
		  (SELECT COUNT(*) FROM stakeholders s WHERE s.tenant_id = p.tenant_id AND s.entity_type = 'project' AND s.entity_id = p.id),
		  (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id)
		FROM projects p
		LEFT JOIN clients c       ON c.id = p.client_id
		LEFT JOIN opportunities o ON o.id = p.opportunity_id
		WHERE p.tenant_id = $1 AND p.deleted_at IS NULL
		  AND p.status IN ('planning','in_progress','qa_review','client_acceptance','invoiced','paid','closed')`
	args := []any{tenantID}
	if status != "" {
		args = append(args, status)
		q += ` AND p.status = $` + itoa(len(args))
	}
	if selfOnly {
		args = append(args, userID)
		q += ` AND EXISTS (
		         SELECT 1 FROM project_members pm
		          WHERE pm.project_id = p.id
		            AND pm.user_id    = $` + itoa(len(args)) + `
		            AND pm.removed_at IS NULL
		       )`
	}
	q += ` ORDER BY p.updated_at DESC LIMIT 200`

	rows, err := s.db.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ListItem{}
	for rows.Next() {
		var p ListItem
		if err := rows.Scan(
			&p.ID, &p.Code, &p.Name, &p.Status, &p.Health, &p.RiskScore,
			&p.Budget, &p.Currency, &p.StartDate, &p.EndDate,
			&p.OpportunityID, &p.ClientName, &p.LeadType,
			&p.UpdatedAt,
			&p.Tasks, &p.TasksDone, &p.Blockers, &p.Stakeholders, &p.Milestones,
		); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

func (s *Service) Create(ctx context.Context, in CreateInput) (uuid.UUID, error) {
	id := uuid.New()
	_, err := s.db.Exec(ctx, `
		INSERT INTO projects (id, tenant_id, opportunity_id, client_id, code, name, category,
		                      priority, budget_amount, currency, start_date, end_date, status, created_by)
		VALUES ($1,$2,NULLIF($3,'00000000-0000-0000-0000-000000000000')::uuid,$4,$5,$6,$7,$8,$9,
		        COALESCE(NULLIF($10,''),'USD'), NULLIF($11,'')::date, NULLIF($12,'')::date, 'planning', $13)`,
		id, in.TenantID, in.OpportunityID, in.ClientID, in.Code, in.Name, in.Category,
		in.Priority, in.Budget, in.Currency, in.StartDate, in.EndDate, in.CreatedBy)
	return id, err
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (map[string]any, error) {
	var (
		p           Project
		oppID       *uuid.UUID
		clientID    uuid.UUID
		currency    string
		md          map[string]any
		description string
		leadType    string
		clientName  string
	)
	err := s.db.QueryRow(ctx, `
		SELECT p.id, p.code, p.name, p.status, p.health, p.risk_score,
		       COALESCE(p.budget_amount,0), p.start_date, p.end_date,
		       p.opportunity_id, p.client_id, p.currency, p.metadata,
		       COALESCE(o.proposal_summary, ''),
		       COALESCE(o.lead_type, ''),
		       COALESCE(c.name, '')
		FROM projects p
		LEFT JOIN opportunities o ON o.id = p.opportunity_id
		LEFT JOIN clients c       ON c.id = p.client_id
		WHERE p.id=$1 AND p.deleted_at IS NULL`, id).
		Scan(&p.ID, &p.Code, &p.Name, &p.Status, &p.Health, &p.RiskScore, &p.Budget,
			&p.StartDate, &p.EndDate, &oppID, &clientID, &currency, &md, &description,
			&leadType, &clientName)
	if err != nil {
		return nil, err
	}
	if md == nil {
		md = map[string]any{}
	}
	links := md["links"]
	if links == nil {
		links = []any{}
	}
	// Milestones — include the assignee so the UI can render an avatar + name
	// without a second roundtrip. Description is optional task-style detail.
	milestones := []map[string]any{}
	if rows, err := s.db.Query(ctx, `
		SELECT m.id, m.title, COALESCE(m.description,''), m.due_on, m.status, m.created_at,
		       m.assignee_id, COALESCE(u.full_name,''), COALESCE(u.email::text,'')
		FROM milestones m
		LEFT JOIN users u ON u.id = m.assignee_id
		WHERE m.project_id=$1
		ORDER BY m.due_on NULLS LAST, m.created_at`, p.ID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				mid                            uuid.UUID
				title, description, status     string
				due                            *time.Time
				ca                             time.Time
				assignee                       *uuid.UUID
				assigneeName, assigneeEmail    string
			)
			if err := rows.Scan(&mid, &title, &description, &due, &status, &ca,
				&assignee, &assigneeName, &assigneeEmail); err == nil {
				milestones = append(milestones, map[string]any{
					"id":             mid,
					"title":          title,
					"description":    description,
					"due_on":         due,
					"status":         status,
					"created_at":     ca,
					"assignee_id":    assignee,
					"assignee_name":  assigneeName,
					"assignee_email": assigneeEmail,
				})
			}
		}
	}

	// Invoices
	invoices := []map[string]any{}
	var invTotal, invPaid float64
	if rows, err := s.db.Query(ctx, `
		SELECT id, number, amount::float8, currency, status, issued_on
		FROM invoices WHERE project_id=$1 ORDER BY issued_on DESC NULLS LAST`, p.ID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				iid          uuid.UUID
				number, st   string
				ccy          string
				amt          float64
				issued       *time.Time
			)
			if err := rows.Scan(&iid, &number, &amt, &ccy, &st, &issued); err == nil {
				invoices = append(invoices, map[string]any{
					"id": iid, "number": number, "amount": amt, "currency": ccy,
					"status": st, "issued_on": issued,
				})
				invTotal += amt
				if st == "paid" {
					invPaid += amt
				}
			}
		}
	}

	// GitHub repos linked to this project
	repos := []map[string]any{}
	if rows, err := s.db.Query(ctx, `
		SELECT id, owner, name FROM gh_repositories WHERE project_id=$1`, p.ID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				rid          uuid.UUID
				owner, name  string
			)
			if err := rows.Scan(&rid, &owner, &name); err == nil {
				repos = append(repos, map[string]any{"id": rid, "owner": owner, "name": name})
			}
		}
	}

	return map[string]any{
		"id": p.ID, "code": p.Code, "name": p.Name, "status": p.Status,
		"health": p.Health, "risk_score": p.RiskScore, "budget": p.Budget,
		"start_date": p.StartDate, "end_date": p.EndDate,
		"opportunity_id": oppID,
		"client_id":      clientID,
		"client_name":    clientName,
		"currency":       currency,
		"description":    description,
		"lead_type":      leadType,
		"links":          links,
		"metadata":       md,
		"milestones":     milestones,
		"invoices":       invoices,
		"invoice_total":  invTotal,
		"invoice_paid":   invPaid,
		"repos":          repos,
	}, nil
}

// Archive soft-deletes the project (sets deleted_at).
func (s *Service) Archive(ctx context.Context, id, tenantID uuid.UUID) error {
	_, err := s.db.Exec(ctx, `
		UPDATE projects SET deleted_at = now(), updated_at = now()
		WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tenantID)
	return err
}

// Restore clears deleted_at on a previously-archived project.
func (s *Service) Restore(ctx context.Context, id, tenantID uuid.UUID) error {
	_, err := s.db.Exec(ctx, `
		UPDATE projects SET deleted_at = NULL, updated_at = now()
		WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL`, id, tenantID)
	return err
}

// ListArchived returns soft-deleted projects for a tenant.
func (s *Service) ListArchived(ctx context.Context, tenantID uuid.UUID) ([]ListItem, error) {
	rows, err := s.db.Query(ctx, `
		SELECT
		  p.id, p.code, p.name, p.status, p.health, p.risk_score,
		  COALESCE(p.budget_amount, 0), p.currency, p.start_date, p.end_date,
		  p.opportunity_id, COALESCE(c.name, ''), COALESCE(o.lead_type, ''),
		  p.deleted_at,
		  0, 0, 0, 0, 0
		FROM projects p
		LEFT JOIN clients c       ON c.id = p.client_id
		LEFT JOIN opportunities o ON o.id = p.opportunity_id
		WHERE p.tenant_id = $1 AND p.deleted_at IS NOT NULL
		ORDER BY p.deleted_at DESC LIMIT 200`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ListItem{}
	for rows.Next() {
		var p ListItem
		if err := rows.Scan(
			&p.ID, &p.Code, &p.Name, &p.Status, &p.Health, &p.RiskScore,
			&p.Budget, &p.Currency, &p.StartDate, &p.EndDate,
			&p.OpportunityID, &p.ClientName, &p.LeadType,
			&p.UpdatedAt,
			&p.Tasks, &p.TasksDone, &p.Blockers, &p.Stakeholders, &p.Milestones,
		); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// AppendLog appends an item to a JSON array under metadata.{kind}.
// Used for metadata.risks, metadata.reports, metadata.audit_log.
func (s *Service) AppendLog(ctx context.Context, id uuid.UUID, kind string, item map[string]any) error {
	b, err := json.Marshal(item)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `
		UPDATE projects
		SET metadata = jsonb_set(
		  COALESCE(metadata, '{}'::jsonb),
		  ARRAY[$1],
		  COALESCE(metadata->$1, '[]'::jsonb) || $2::jsonb,
		  true
		),
		updated_at = now()
		WHERE id = $3`, kind, b, id)
	return err
}

// PatchLogItem replaces a single item by id within metadata.{kind} array.
func (s *Service) PatchLogItem(ctx context.Context, id uuid.UUID, kind, itemID string, patch map[string]any) error {
	b, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `
		WITH updated AS (
		  SELECT jsonb_agg(
		    CASE WHEN x->>'id' = $1 THEN x || $2::jsonb ELSE x END
		  ) AS arr
		  FROM jsonb_array_elements(COALESCE((SELECT metadata->$3 FROM projects WHERE id=$4),'[]'::jsonb)) x
		)
		UPDATE projects p
		SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), ARRAY[$3], COALESCE((SELECT arr FROM updated),'[]'::jsonb), true),
		    updated_at = now()
		WHERE p.id = $4`, itemID, b, kind, id)
	return err
}

// SetMetaKey replaces a single top-level metadata key with the given value.
func (s *Service) SetMetaKey(ctx context.Context, id uuid.UUID, key string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `
		UPDATE projects
		SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), ARRAY[$1], $2::jsonb, true),
		    updated_at = now()
		WHERE id = $3`, key, b, id)
	return err
}

// UpdateLinks replaces metadata.links on the project with the given list.
func (s *Service) UpdateLinks(ctx context.Context, id uuid.UUID, links []map[string]any) error {
	b, err := json.Marshal(links)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `
		UPDATE projects
		SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{links}', $1::jsonb, true),
		    updated_at = now()
		WHERE id=$2`, b, id)
	return err
}

func (s *Service) Board(ctx context.Context, id uuid.UUID) (map[string]any, error) {
	rows, err := s.db.Query(ctx, `
		SELECT t.id, t.title, COALESCE(t.description,''), t.status, t.priority,
		       t.assignee_id, t.due_on, t.start_on, t.created_at,
		       (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comments_count
		FROM tasks t WHERE t.project_id=$1 AND t.deleted_at IS NULL
		ORDER BY t.priority ASC, t.due_on ASC NULLS LAST, t.created_at DESC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// Include "blocked" — the status enum supports it and the kanban needs
	// somewhere to render those cards instead of silently folding them in.
	cols := map[string][]map[string]any{
		"todo": {}, "in_progress": {}, "blocked": {}, "review": {}, "done": {},
	}
	for rows.Next() {
		var (
			tid             uuid.UUID
			assignee        *uuid.UUID
			title, desc     string
			status          string
			prio            int
			due, start      *time.Time
			created         time.Time
			commentsCount   int
		)
		if err := rows.Scan(&tid, &title, &desc, &status, &prio, &assignee, &due, &start, &created, &commentsCount); err != nil {
			continue
		}
		bucket := status
		if _, ok := cols[bucket]; !ok {
			bucket = "todo"
		}
		cols[bucket] = append(cols[bucket], map[string]any{
			"id": tid, "title": title, "description": desc, "status": status,
			"priority": prio, "assignee_id": assignee,
			"due_on": due, "start_on": start, "created_at": created,
			"comments_count": commentsCount,
		})
	}
	return map[string]any{"columns": cols}, nil
}

func (s *Service) AddMilestone(ctx context.Context, projectID uuid.UUID, in MilestoneInput) (uuid.UUID, error) {
	id := uuid.New()
	_, err := s.db.Exec(ctx, `
		INSERT INTO milestones (id, project_id, title, description, due_on, status, assignee_id)
		VALUES ($1, $2, $3, NULLIF($4,''),
		        NULLIF($5,'')::date,
		        COALESCE(NULLIF($6,''),'pending'),
		        NULLIF($7,'00000000-0000-0000-0000-000000000000')::uuid)`,
		id, projectID, in.Title, in.Description, in.DueOn, in.Status, in.AssigneeID)
	return id, err
}

func (s *Service) AddTask(ctx context.Context, projectID uuid.UUID, in TaskInput) (uuid.UUID, error) {
	id := uuid.New()
	_, err := s.db.Exec(ctx, `
		INSERT INTO tasks (id, project_id, milestone_id, title, description, assignee_id,
		                   status, priority, due_on, start_on, created_by)
		VALUES ($1,$2, NULLIF($3,'00000000-0000-0000-0000-000000000000')::uuid, $4, $5,
		        NULLIF($6,'00000000-0000-0000-0000-000000000000')::uuid,
		        COALESCE(NULLIF($7,''),'todo'), COALESCE($8, 3),
		        NULLIF($9,'')::date, NULLIF($10,'')::date, $11)`,
		id, projectID, in.MilestoneID, in.Title, in.Description, in.AssigneeID,
		in.Status, in.Priority, in.DueOn, in.StartOn, in.CreatedBy)
	return id, err
}

// RecalculateRisk computes a composite risk score weighted across delivery,
// financial, dependency, staffing, and compliance dimensions. Result is also
// persisted as a snapshot for trending.
func (s *Service) RecalculateRisk(ctx context.Context, projectID uuid.UUID) (float64, error) {
	var (
		overdueTasks, totalTasks    int
		budget, costToDate          float64
		blockedDeps                 int
		understaffedRatio           float64
		openComplianceViolations    int
	)
	_ = s.db.QueryRow(ctx, `SELECT
		COALESCE(SUM(CASE WHEN due_on < current_date AND status NOT IN ('done','cancelled') THEN 1 ELSE 0 END),0),
		COUNT(*) FROM tasks WHERE project_id=$1 AND deleted_at IS NULL`, projectID).
		Scan(&overdueTasks, &totalTasks)
	_ = s.db.QueryRow(ctx, `SELECT COALESCE(budget_amount,0) FROM projects WHERE id=$1`, projectID).Scan(&budget)
	_ = s.db.QueryRow(ctx, `SELECT COALESCE(SUM(amount),0) FROM expenses WHERE project_id=$1`, projectID).Scan(&costToDate)
	_ = s.db.QueryRow(ctx, `SELECT COUNT(*) FROM project_dependencies WHERE project_id=$1 AND blocked=true`, projectID).Scan(&blockedDeps)
	_ = s.db.QueryRow(ctx, `SELECT COUNT(*) FROM governance_violations
		WHERE entity='project' AND entity_id=$1 AND resolved=false`, projectID).Scan(&openComplianceViolations)

	delivery := 0.0
	if totalTasks > 0 {
		delivery = float64(overdueTasks) / float64(totalTasks)
	}
	financial := 0.0
	if budget > 0 {
		financial = costToDate / budget
		if financial > 1 {
			financial = 1
		}
	}
	dependency := minF(float64(blockedDeps)/3.0, 1)
	staffing := understaffedRatio
	compliance := minF(float64(openComplianceViolations)/3.0, 1)

	score := (delivery*0.30 + financial*0.25 + dependency*0.15 + staffing*0.10 + compliance*0.20) * 100

	health := "green"
	switch {
	case score >= 75:
		health = "red"
	case score >= 50:
		health = "amber"
	}

	_, err := s.db.Exec(ctx, `UPDATE projects SET risk_score=$1, health=$2, updated_at=now() WHERE id=$3`,
		score, health, projectID)
	if err != nil {
		return 0, err
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO project_health_snapshots (project_id, score, health, captured_at)
		VALUES ($1,$2,$3, now())`, projectID, score, health)
	return score, nil
}

func minF(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
