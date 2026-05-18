package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
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

// item is the shape every row returned by the bell uses. Synthetic items
// (overdue tasks, pending approvals) are derived live and auto-clear when
// the underlying state changes. Real engine events come from notification_outbox
// — those carry an outbox UUID so the frontend can mark them read.
type item struct {
	ID       string                 `json:"id"`
	Kind     string                 `json:"kind"`
	Severity string                 `json:"severity"` // info | warn | danger | critical
	Title    string                 `json:"title"`
	Body     string                 `json:"body"`
	Link     string                 `json:"link"`
	At       string                 `json:"at"`
	OutboxID string                 `json:"outbox_id,omitempty"` // present for real engine events
	Read     bool                   `json:"read,omitempty"`
	Payload  map[string]any         `json:"payload,omitempty"`
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

	// Load dismissed item ids for this user so we can hide them from the feed.
	dismissed := map[string]struct{}{}
	if dRows, err := h.db.Query(c, `SELECT item_id FROM notification_dismissals WHERE user_id=$1`, uid); err == nil {
		defer dRows.Close()
		for dRows.Next() {
			var s string
			if err := dRows.Scan(&s); err == nil {
				dismissed[s] = struct{}{}
			}
		}
	}

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
		       COALESCE(o.contract_model,'fixed_fee'),
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
				title, leadType, contractModel string
				est float64
				attached int
			)
			if err := docRows.Scan(&oid, &title, &leadType, &est, &contractModel, &attached); err != nil { continue }
			required := len(governance.RequiredDocsFor(leadType, est, contractModel))
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

	// 4. Engine-dispatched events from the outbox (e.g. leave decisions,
	//    mentions, kudos, milestone assignments). Last 30 days, unread first.
	//    These carry an OutboxID so the frontend can mark them read explicitly.
	outRows, _ := h.db.Query(c, `
		SELECT id, event_kind, category, subject, payload, COALESCE(link,''),
		       created_at, read_at IS NOT NULL AS is_read
		FROM notification_outbox
		WHERE user_id=$1 AND created_at > now() - interval '30 days'
		ORDER BY (read_at IS NULL) DESC, created_at DESC
		LIMIT 60`, uid)
	if outRows != nil {
		defer outRows.Close()
		for outRows.Next() {
			var (
				oid                    uuid.UUID
				kind, cat, subj, link  string
				payloadRaw             []byte
				created                time.Time
				isRead                 bool
			)
			if err := outRows.Scan(&oid, &kind, &cat, &subj, &payloadRaw, &link, &created, &isRead); err != nil {
				continue
			}
			payload := map[string]any{}
			_ = json.Unmarshal(payloadRaw, &payload)
			sev := outboxSeverity(kind)
			body := outboxBody(kind, payload)
			out = append(out, item{
				ID:       "outbox:" + oid.String(),
				OutboxID: oid.String(),
				Kind:     kind,
				Severity: sev,
				Title:    subj,
				Body:     body,
				Link:     link,
				At:       created.Format(time.RFC3339),
				Read:     isRead,
				Payload:  payload,
			})
		}
	}

	// Filter out items the user has explicitly dismissed.
	if len(dismissed) > 0 {
		filtered := out[:0]
		for _, it := range out {
			if _, hide := dismissed[it.ID]; hide {
				continue
			}
			filtered = append(filtered, it)
		}
		out = filtered
	}

	// Unread = synthetic items (always "unread") + unread outbox rows.
	unread := 0
	for _, it := range out {
		if it.OutboxID == "" || !it.Read {
			unread++
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"items":  out,
		"unread": unread,
	})
}

// Dismiss — POST /notifications/:id/dismiss.
// Hides the item from this user's feed. Works for both synthetic ids (e.g.
// "task:overdue:<uuid>") and outbox ids. For outbox items we also stamp
// read_at so unread counts elsewhere stay consistent.
func (h *Notifications) Dismiss(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	raw := c.Param("id")
	if raw == "" {
		c.JSON(400, gin.H{"error": "missing id"})
		return
	}
	_, _ = h.db.Exec(c,
		`INSERT INTO notification_dismissals (user_id, item_id)
		 VALUES ($1, $2) ON CONFLICT DO NOTHING`, uid, raw)
	if strings.HasPrefix(raw, "outbox:") {
		if id, err := uuid.Parse(strings.TrimPrefix(raw, "outbox:")); err == nil {
			_, _ = h.db.Exec(c,
				`UPDATE notification_outbox SET read_at=COALESCE(read_at, now())
				 WHERE id=$1 AND user_id=$2`, id, uid)
		}
	}
	c.JSON(200, gin.H{"ok": true})
}

// DismissAll — POST /notifications/dismiss-all.
// Bulk-dismisses every currently-visible item for this user by inserting one
// row per item id passed in. Falls back to no-op if the body is missing.
func (h *Notifications) DismissAll(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := c.BindJSON(&body); err != nil || len(body.IDs) == 0 {
		c.JSON(200, gin.H{"ok": true})
		return
	}
	tx, err := h.db.Begin(c)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(c)
	for _, id := range body.IDs {
		_, _ = tx.Exec(c,
			`INSERT INTO notification_dismissals (user_id, item_id)
			 VALUES ($1, $2) ON CONFLICT DO NOTHING`, uid, id)
	}
	_ = tx.Commit(c)
	c.JSON(200, gin.H{"ok": true})
}

// outboxSeverity maps an event kind to a UI severity bucket. Falls back to
// "info" when the kind isn't explicitly classified.
func outboxSeverity(kind string) string {
	switch {
	case kind == "leave.rejected" || kind == "task.rejected" || kind == "governance.approval_rejected":
		return "danger"
	case kind == "leave.approved" || kind == "task.approved" || kind == "governance.approval_granted":
		return "info"
	case kind == "task.comment_mention":
		return "info"
	case kind == "milestone.created" || kind == "milestone.due_soon":
		return "warn"
	case kind == "milestone.overdue" || kind == "task.overdue":
		return "danger"
	default:
		return "info"
	}
}

// outboxBody pulls a human one-liner from the event payload, biased toward the
// fields that actually carry context (Reason, Body, Description, Project, etc.)
// so the bell row doesn't repeat the subject verbatim.
func outboxBody(kind string, p map[string]any) string {
	pick := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := p[k].(string); ok && strings.TrimSpace(v) != "" {
				return v
			}
		}
		return ""
	}
	switch kind {
	case "leave.rejected":
		actor := pick("Actor")
		reason := pick("Reason")
		if actor != "" && reason != "" {
			return actor + " · \"" + reason + "\""
		}
		return reason
	case "leave.approved":
		actor := pick("Actor")
		if actor != "" {
			return "Approved by " + actor
		}
		return ""
	case "task.comment_mention":
		body := pick("Body")
		where := pick("Where", "Title")
		if where != "" && body != "" {
			return where + ": " + body
		}
		return body
	case "milestone.created":
		return pick("Project", "Title")
	default:
		// Generic — surface a "Project / Title" if present, otherwise stay quiet
		// so the subject line carries the message.
		if v := pick("Project", "Title", "Body"); v != "" {
			return v
		}
		return ""
	}
}

// MarkRead — POST /notifications/:id/read.
// Stamps read_at on a single outbox row if the id is "outbox:<uuid>"; ignores
// synthetic ids (their state lives in the underlying entity).
func (h *Notifications) MarkRead(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	raw := c.Param("id")
	if strings.HasPrefix(raw, "outbox:") {
		id, err := uuid.Parse(strings.TrimPrefix(raw, "outbox:"))
		if err == nil {
			_, _ = h.db.Exec(c,
				`UPDATE notification_outbox SET read_at=now()
				 WHERE id=$1 AND user_id=$2 AND read_at IS NULL`, id, uid)
		}
	}
	c.JSON(200, gin.H{"ok": true})
}

// MarkAllRead — POST /notifications/read-all.
// Single statement marks every unread outbox row for the caller. Synthetic
// items continue to auto-clear as their underlying state changes.
func (h *Notifications) MarkAllRead(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	_, _ = h.db.Exec(c,
		`UPDATE notification_outbox SET read_at=now()
		 WHERE user_id=$1 AND read_at IS NULL`, uid)
	c.JSON(200, gin.H{"ok": true})
}

func sameDay(a, b time.Time) bool {
	return a.Year() == b.Year() && a.YearDay() == b.YearDay()
}
func plural(n int) string {
	if n == 1 { return "" }
	return "s"
}
