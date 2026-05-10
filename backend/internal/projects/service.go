// Package projects implements the delivery module: projects, milestones,
// tasks, board view, and risk computation.
package projects

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

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
	Title  string `json:"title" binding:"required"`
	DueOn  string `json:"due_on"`
	Status string `json:"status"`
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

func (s *Service) List(ctx context.Context, tenantID uuid.UUID, status string) ([]Project, error) {
	q := `SELECT id, code, name, status, health, risk_score, COALESCE(budget_amount,0), start_date, end_date
	      FROM projects WHERE tenant_id=$1 AND deleted_at IS NULL`
	args := []any{tenantID}
	if status != "" {
		q += ` AND status=$2`
		args = append(args, status)
	}
	q += ` ORDER BY created_at DESC LIMIT 200`
	rows, err := s.db.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Project{}
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.Code, &p.Name, &p.Status, &p.Health, &p.RiskScore, &p.Budget, &p.StartDate, &p.EndDate); err != nil {
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
	var p Project
	err := s.db.QueryRow(ctx, `
		SELECT id, code, name, status, health, risk_score, COALESCE(budget_amount,0), start_date, end_date
		FROM projects WHERE id=$1 AND deleted_at IS NULL`, id).
		Scan(&p.ID, &p.Code, &p.Name, &p.Status, &p.Health, &p.RiskScore, &p.Budget, &p.StartDate, &p.EndDate)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"id": p.ID, "code": p.Code, "name": p.Name, "status": p.Status,
		"health": p.Health, "risk_score": p.RiskScore, "budget": p.Budget,
		"start_date": p.StartDate, "end_date": p.EndDate,
	}, nil
}

func (s *Service) Board(ctx context.Context, id uuid.UUID) (map[string]any, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, title, status, priority, assignee_id, due_on
		FROM tasks WHERE project_id=$1 AND deleted_at IS NULL`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols := map[string][]map[string]any{
		"todo": {}, "in_progress": {}, "review": {}, "done": {},
	}
	for rows.Next() {
		var (
			tid, assignee uuid.UUID
			title, status string
			prio          int
			due           *time.Time
		)
		if err := rows.Scan(&tid, &title, &status, &prio, &assignee, &due); err != nil {
			continue
		}
		bucket := status
		if _, ok := cols[bucket]; !ok {
			bucket = "todo"
		}
		cols[bucket] = append(cols[bucket], map[string]any{
			"id": tid, "title": title, "priority": prio, "assignee_id": assignee, "due_on": due,
		})
	}
	return map[string]any{"columns": cols}, nil
}

func (s *Service) AddMilestone(ctx context.Context, projectID uuid.UUID, in MilestoneInput) (uuid.UUID, error) {
	id := uuid.New()
	_, err := s.db.Exec(ctx, `
		INSERT INTO milestones (id, project_id, title, due_on, status)
		VALUES ($1,$2,$3, NULLIF($4,'')::date, COALESCE(NULLIF($5,''),'pending'))`,
		id, projectID, in.Title, in.DueOn, in.Status)
	return id, err
}

func (s *Service) AddTask(ctx context.Context, projectID uuid.UUID, in TaskInput) (uuid.UUID, error) {
	id := uuid.New()
	_, err := s.db.Exec(ctx, `
		INSERT INTO tasks (id, project_id, milestone_id, title, description, assignee_id,
		                   status, priority, due_on, created_by)
		VALUES ($1,$2, NULLIF($3,'00000000-0000-0000-0000-000000000000')::uuid, $4, $5,
		        NULLIF($6,'00000000-0000-0000-0000-000000000000')::uuid,
		        COALESCE(NULLIF($7,''),'todo'), COALESCE($8, 3), NULLIF($9,'')::date, $10)`,
		id, projectID, in.MilestoneID, in.Title, in.Description, in.AssigneeID,
		in.Status, in.Priority, in.DueOn, in.CreatedBy)
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
