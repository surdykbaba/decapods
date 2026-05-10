package handlers

import (
	"fmt"
	"net/http"
	"time"

	"github.com/decapods/pgdp/backend/internal/governance"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Notifications struct {
	db *pgxpool.Pool
}

func NewNotifications(db *pgxpool.Pool) *Notifications { return &Notifications{db: db} }

// item is the shape every row returned by the bell uses. These are derived live
// from the current state — they aren't entries in a log, so they auto-clear as
// soon as the underlying condition is resolved (task closed, doc attached,
// opportunity approved, etc.).
type item struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Severity string `json:"severity"` // info | warn | danger
	Title    string `json:"title"`
	Body     string `json:"body"`
	Link     string `json:"link"`
	At       string `json:"at"`
}

// List returns *attention items* — tasks and approvals waiting on the
// current user. Anything resolved disappears automatically; we never
// surface trail/audit events here.
func (h *Notifications) List(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)

	out := []item{}
	now := time.Now().UTC()

	// 1. Tasks: overdue, due today, blocked.
	rows, _ := h.db.Query(c, `
		SELECT t.id, t.title, t.status, t.due_on, p.id, p.name
		FROM tasks t JOIN projects p ON p.id=t.project_id
		WHERE p.tenant_id=$1 AND t.assignee_id=$2
		      AND t.deleted_at IS NULL AND t.status <> 'done'
		ORDER BY (t.due_on IS NULL), t.due_on ASC LIMIT 50`, tid, uid)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var (
				tid uuid.UUID; title, status string; due *time.Time
				pid uuid.UUID; pname string
			)
			if err := rows.Scan(&tid, &title, &status, &due, &pid, &pname); err != nil { continue }
			link := fmt.Sprintf("/projects/%s", pid)
			switch {
			case status == "blocked":
				out = append(out, item{
					ID: "task:blocked:" + tid.String(), Kind: "task.blocked", Severity: "warn",
					Title: "Task blocked", Body: title + " · " + pname,
					Link: link, At: now.Format(time.RFC3339),
				})
			case due != nil && due.Before(now):
				days := int(now.Sub(*due).Hours() / 24)
				if days < 1 { days = 1 }
				out = append(out, item{
					ID: "task:overdue:" + tid.String(), Kind: "task.overdue", Severity: "danger",
					Title: fmt.Sprintf("Task overdue · %dd", days),
					Body:  title + " · " + pname,
					Link:  link, At: due.Format(time.RFC3339),
				})
			case due != nil && sameDay(*due, now):
				out = append(out, item{
					ID: "task:duetoday:" + tid.String(), Kind: "task.due_today", Severity: "warn",
					Title: "Due today",
					Body:  title + " · " + pname,
					Link:  link, At: now.Format(time.RFC3339),
				})
			}
		}
	}

	// 2. Approvals waiting on me — opportunities in under_review where my role
	//    has at least one allowed transition out.
	wf, _ := governance.LoadWorkflow(c, h.db, tid)
	approvalRows, _ := h.db.Query(c, `
		SELECT id, title, updated_at FROM opportunities
		WHERE tenant_id=$1 AND deleted_at IS NULL AND stage='under_review'
		ORDER BY updated_at DESC LIMIT 30`, tid)
	if approvalRows != nil {
		defer approvalRows.Close()
		for approvalRows.Next() {
			var (
				oid uuid.UUID; title string; at time.Time
			)
			if err := approvalRows.Scan(&oid, &title, &at); err != nil { continue }
			allowed := wf.AllowedTransitions("under_review", roles)
			if len(allowed) == 0 { continue }
			out = append(out, item{
				ID: "opp:approve:" + oid.String(), Kind: "opportunity.awaiting_approval", Severity: "info",
				Title: "Approval waiting on you",
				Body:  title,
				Link:  "/pipeline/" + oid.String(),
				At:    at.Format(time.RFC3339),
			})
		}
	}

	// 3. Missing required documents on opportunities I created (or any I created
	//    that are still in new_request).
	docRows, _ := h.db.Query(c, `
		SELECT o.id, o.title, o.lead_type, o.estimated_value,
		       (SELECT COUNT(*) FROM opportunity_documents d WHERE d.opportunity_id=o.id) AS attached
		FROM opportunities o
		WHERE o.tenant_id=$1 AND o.deleted_at IS NULL AND o.stage='new_request'
		      AND o.created_by=$2
		ORDER BY o.updated_at DESC LIMIT 30`, tid, uid)
	if docRows != nil {
		defer docRows.Close()
		for docRows.Next() {
			var (
				oid uuid.UUID
				title, leadType string
				est float64
				attached int
			)
			if err := docRows.Scan(&oid, &title, &leadType, &est, &attached); err != nil { continue }
			required := len(governance.RequiredDocsFor(leadType, est))
			missing := required - attached
			if missing <= 0 { continue }
			out = append(out, item{
				ID: "opp:missing-docs:" + oid.String(), Kind: "opportunity.missing_documents", Severity: "warn",
				Title: fmt.Sprintf("%d document%s still required", missing, plural(missing)),
				Body:  title,
				Link:  "/pipeline/" + oid.String(),
				At:    now.Format(time.RFC3339),
			})
		}
	}

	// 4. Projects I'm a member of with amber/red health.
	projRows, _ := h.db.Query(c, `
		SELECT DISTINCT p.id, p.name, p.health, p.updated_at
		FROM project_members pm JOIN projects p ON p.id = pm.project_id
		WHERE p.tenant_id=$1 AND pm.user_id=$2 AND pm.removed_at IS NULL
		      AND p.deleted_at IS NULL AND p.status NOT IN ('paid','closed')
		      AND p.health IN ('amber','red')
		ORDER BY p.updated_at DESC LIMIT 20`, tid, uid)
	if projRows != nil {
		defer projRows.Close()
		for projRows.Next() {
			var (
				pid uuid.UUID; name, health string; at time.Time
			)
			if err := projRows.Scan(&pid, &name, &health, &at); err != nil { continue }
			sev := "warn"
			if health == "red" { sev = "danger" }
			out = append(out, item{
				ID: "proj:health:" + pid.String() + ":" + health, Kind: "project.health", Severity: sev,
				Title: fmt.Sprintf("Project health %s", health),
				Body:  name,
				Link:  "/projects/" + pid.String(),
				At:    at.Format(time.RFC3339),
			})
		}
	}

	// 5. Personal: nudge to submit a daily update if it's been > 1 day.
	var lastDaily *time.Time
	_ = h.db.QueryRow(c, `SELECT MAX(for_date) FROM personal_updates
		WHERE tenant_id=$1 AND user_id=$2 AND kind='daily'`, tid, uid).Scan(&lastDaily)
	overdue := lastDaily == nil || time.Since(*lastDaily) > 30*time.Hour
	if overdue {
		days := 0
		if lastDaily != nil { days = int(time.Since(*lastDaily).Hours() / 24) }
		title := "Submit your daily update"
		if days >= 2 { title = fmt.Sprintf("%dd since your last update", days) }
		out = append(out, item{
			ID: "me:daily-update", Kind: "personal.daily_update_pending", Severity: "info",
			Title: title,
			Body:  "Drop a quick standup so the team has visibility.",
			Link:  "/my-work?tab=updates&new=1",
			At:    now.Format(time.RFC3339),
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"items":  out,
		"unread": len(out), // every attention item is unread by definition
	})
}

// MarkRead/MarkAllRead are kept for API compatibility but become no-ops:
// derived attention items are auto-resolved when the underlying state changes.
func (h *Notifications) MarkRead(c *gin.Context)    { c.JSON(200, gin.H{"ok": true}) }
func (h *Notifications) MarkAllRead(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) }

func sameDay(a, b time.Time) bool {
	return a.Year() == b.Year() && a.YearDay() == b.YearDay()
}
func plural(n int) string {
	if n == 1 { return "" }
	return "s"
}
