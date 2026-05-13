package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/notifications"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Leave struct {
	db     *pgxpool.Pool
	notify *notifications.Engine
}

func NewLeave(db *pgxpool.Pool) *Leave { return &Leave{db: db} }

// WithEngine attaches the notification engine so leave handlers can fan out
// submit/decision events. Optional — without it, leave still works, just
// silently (the engine pointer is nil-safe inside).
func (h *Leave) WithEngine(engine *notifications.Engine) *Leave {
	h.notify = engine
	return h
}

// Roles that can act at each approval stage. Manager-stage covers anyone who
// runs delivery; HR-stage gates the workspace's compliance/people lens.
// super_admin can act at either stage.
func canApproveAsManager(roles []string) bool {
	for _, r := range roles {
		switch r {
		case "super_admin", "ceo", "coo", "delivery_manager", "project_manager":
			return true
		}
	}
	return false
}
func canApproveAsHR(roles []string) bool {
	for _, r := range roles {
		if r == "super_admin" || r == "hr" || r == "hr_manager" {
			return true
		}
	}
	return false
}

// ListTypes — GET /api/v1/leave/types
// Returns the tenant's leave-type catalog.
func (h *Leave) ListTypes(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c, `
		SELECT id, code, name, paid, default_days::float8, max_carryover::float8, requires_docs, active
		  FROM leave_types
		 WHERE tenant_id=$1
		 ORDER BY (CASE code WHEN 'annual' THEN 0 WHEN 'sick' THEN 1 ELSE 9 END), name`, tid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id                      uuid.UUID
			code, name              string
			paid, requiresDocs, act bool
			defaultDays, carryover  float64
		)
		if err := rows.Scan(&id, &code, &name, &paid, &defaultDays, &carryover, &requiresDocs, &act); err == nil {
			out = append(out, gin.H{
				"id": id, "code": code, "name": name, "paid": paid,
				"default_days": defaultDays, "max_carryover": carryover,
				"requires_docs": requiresDocs, "active": act,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// Balances — GET /api/v1/leave/balances
// Returns the caller's balances per leave type for the current year. Auto-seeds
// missing rows from the type's default_days so a brand-new member sees their
// allowance immediately.
func (h *Leave) Balances(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	year := time.Now().Year()

	// Seed any missing balance rows for active types so the response is complete.
	_, _ = h.db.Exec(c, `
		INSERT INTO leave_balances (tenant_id, user_id, leave_type_id, year, accrued_days)
		SELECT $1, $2, lt.id, $3, lt.default_days
		  FROM leave_types lt
		 WHERE lt.tenant_id=$1 AND lt.active=true
		   AND NOT EXISTS (
		     SELECT 1 FROM leave_balances b
		      WHERE b.user_id=$2 AND b.leave_type_id=lt.id AND b.year=$3
		   )`, tid, uid, year)

	rows, err := h.db.Query(c, `
		SELECT lt.id, lt.code, lt.name, lt.paid,
		       b.accrued_days::float8, b.carryover_days::float8, b.used_days::float8
		  FROM leave_balances b JOIN leave_types lt ON lt.id = b.leave_type_id
		 WHERE b.tenant_id=$1 AND b.user_id=$2 AND b.year=$3
		 ORDER BY (CASE lt.code WHEN 'annual' THEN 0 WHEN 'sick' THEN 1 ELSE 9 END), lt.name`,
		tid, uid, year)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id                       uuid.UUID
			code, name               string
			paid                     bool
			accrued, carry, used     float64
		)
		if err := rows.Scan(&id, &code, &name, &paid, &accrued, &carry, &used); err == nil {
			out = append(out, gin.H{
				"leave_type_id": id, "code": code, "name": name, "paid": paid,
				"accrued_days": accrued, "carryover_days": carry, "used_days": used,
				"remaining_days": accrued + carry - used,
				"year": year,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out, "year": year})
}

// ListRequests — GET /api/v1/leave/requests?scope=mine|team&status=pending|...&from=&to=
// scope=mine returns the caller's own requests; scope=team returns every
// request in the tenant (used by managers/HR). Includes approval_stage and
// the audit log of decisions made so far.
func (h *Leave) ListRequests(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	scope := c.Query("scope")
	if scope != "team" { scope = "mine" }

	args := []any{tid}
	q := `SELECT r.id, r.user_id, COALESCE(u.full_name,''), COALESCE(u.email::text,''),
	             r.leave_type_id, lt.code, lt.name, lt.paid,
	             r.start_date, r.end_date, r.days::float8, r.duration,
	             r.reason, r.handover_notes,
	             r.backup_user_id, COALESCE(bu.full_name, ''),
	             r.status, r.approval_stage, r.approvals,
	             r.submitted_at, r.created_at
	        FROM leave_requests r
	        JOIN users u   ON u.id = r.user_id
	        JOIN leave_types lt ON lt.id = r.leave_type_id
	        LEFT JOIN users bu ON bu.id = r.backup_user_id
	       WHERE r.tenant_id = $1`
	if scope == "mine" {
		args = append(args, uid)
		q += " AND r.user_id = $2"
	}
	if s := c.Query("status"); s != "" {
		args = append(args, s)
		q += " AND r.status = $" + intStr(len(args))
	}
	if f := c.Query("from"); f != "" {
		args = append(args, f)
		q += " AND r.end_date >= $" + intStr(len(args)) + "::date"
	}
	if t := c.Query("to"); t != "" {
		args = append(args, t)
		q += " AND r.start_date <= $" + intStr(len(args)) + "::date"
	}
	q += " ORDER BY r.start_date DESC, r.submitted_at DESC LIMIT 500"

	rows, err := h.db.Query(c, q, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id, userID, typeID                                                  uuid.UUID
			backupID                                                            *uuid.UUID
			userName, userEmail, code, typeName, reason, handover, backupName   string
			status, stage, duration                                             string
			paid                                                                bool
			start, end                                                          time.Time
			submittedAt, createdAt                                              any
			days                                                                float64
			approvalsRaw                                                        []byte
		)
		if err := rows.Scan(&id, &userID, &userName, &userEmail, &typeID, &code, &typeName, &paid,
			&start, &end, &days, &duration, &reason, &handover, &backupID, &backupName,
			&status, &stage, &approvalsRaw, &submittedAt, &createdAt); err == nil {
			var approvals []map[string]any
			_ = json.Unmarshal(approvalsRaw, &approvals)
			out = append(out, gin.H{
				"id": id, "user_id": userID, "user_name": userName, "user_email": userEmail,
				"leave_type_id": typeID, "code": code, "type_name": typeName, "paid": paid,
				"start_date": start.Format("2006-01-02"),
				"end_date":   end.Format("2006-01-02"),
				"days": days, "duration": duration,
				"reason": reason, "handover_notes": handover,
				"backup_user_id": backupID, "backup_user_name": backupName,
				"status": status, "approval_stage": stage, "approvals": approvals,
				"submitted_at": submittedAt, "created_at": createdAt,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// CreateRequest — POST /api/v1/leave/requests
// Accepts optional duration (full_day | half_day_am | half_day_pm) which
// downscales the working-days count for half-day requests. New requests enter
// approval_stage="manager_pending", status="pending".
func (h *Leave) CreateRequest(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		LeaveTypeID   string `json:"leave_type_id" binding:"required,uuid"`
		StartDate     string `json:"start_date"    binding:"required"`
		EndDate       string `json:"end_date"      binding:"required"`
		Duration      string `json:"duration"`
		Reason        string `json:"reason"`
		HandoverNotes string `json:"handover_notes"`
		BackupUserID  string `json:"backup_user_id"`
		SupportingDocs []map[string]any `json:"supporting_docs"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	start, err := time.Parse("2006-01-02", req.StartDate)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad start_date"}); return
	}
	end, err := time.Parse("2006-01-02", req.EndDate)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad end_date"}); return
	}
	if end.Before(start) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "end_date can't be before start_date"}); return
	}
	typeID, err := uuid.Parse(req.LeaveTypeID)
	if err != nil { c.JSON(http.StatusBadRequest, gin.H{"error": "bad leave_type_id"}); return }

	// Only one live leave per person — block if they have a pending request,
	// or an approved one that hasn't ended yet. Past leave doesn't count;
	// cancelled / rejected don't count either.
	var activeID uuid.UUID
	if err := h.db.QueryRow(c, `
		SELECT id FROM leave_requests
		WHERE tenant_id=$1 AND user_id=$2
		  AND status IN ('pending','approved')
		  AND end_date >= CURRENT_DATE
		LIMIT 1`, tid, uid).Scan(&activeID); err == nil {
		c.JSON(http.StatusConflict, gin.H{
			"error": "You already have an active leave request. Cancel it or wait for it to end before requesting another.",
			"active_request_id": activeID,
		})
		return
	}

	var typeName string
	if err := h.db.QueryRow(c, `SELECT name FROM leave_types WHERE id=$1 AND tenant_id=$2 AND active=true`, typeID, tid).Scan(&typeName); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown leave type"}); return
	}

	var backupID *uuid.UUID
	if strings.TrimSpace(req.BackupUserID) != "" {
		b, err := uuid.Parse(req.BackupUserID)
		if err != nil { c.JSON(http.StatusBadRequest, gin.H{"error": "bad backup_user_id"}); return }
		// Backup must be a member of this tenant — otherwise we'd be sending the
		// handover docs to a stranger.
		var ok bool
		if err := h.db.QueryRow(c, `SELECT EXISTS (SELECT 1 FROM users WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL)`, b, tid).Scan(&ok); err != nil || !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "backup user not in this workspace"}); return
		}
		backupID = &b
	}

	duration := strings.TrimSpace(req.Duration)
	if duration == "" { duration = "full_day" }
	switch duration {
	case "full_day", "half_day_am", "half_day_pm":
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "duration must be full_day, half_day_am or half_day_pm"}); return
	}
	days := workingDays(start, end)
	if duration != "full_day" {
		// Half-day requests must start and end on the same day.
		if !start.Equal(end) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "half-day leave must span a single date"}); return
		}
		days = 0.5
	}

	docsJSON, _ := json.Marshal(req.SupportingDocs)
	if len(docsJSON) == 0 { docsJSON = []byte("[]") }

	var id uuid.UUID
	if err := h.db.QueryRow(c, `
		INSERT INTO leave_requests (tenant_id, user_id, leave_type_id, start_date, end_date, days, duration,
		                            reason, handover_notes, backup_user_id, supporting_docs,
		                            status, approval_stage)
		VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11::jsonb,'pending','manager_pending')
		RETURNING id`,
		tid, uid, typeID, req.StartDate, req.EndDate, days, duration,
		strings.TrimSpace(req.Reason), strings.TrimSpace(req.HandoverNotes), backupID,
		string(docsJSON)).Scan(&id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Fan out notifications to anyone who can approve at the manager stage.
	// Doesn't block the response — the engine deals with queueing/email
	// itself, and we ignore any errors so leave still works without SMTP.
	go h.notifyManagerStage(context.Background(), tid, id, uid, typeName, req.StartDate, req.EndDate, days)

	c.JSON(http.StatusCreated, gin.H{"id": id, "days": days, "approval_stage": "manager_pending"})
}

// notifyManagerStage emails / in-app-pings everyone who carries a manager-class
// role in the tenant. Best-effort: we look up by role membership rather than
// a hard-coded list, so workspaces with custom role taxonomies still light
// up the right people.
func (h *Leave) notifyManagerStage(ctx context.Context, tid, requestID, requesterID uuid.UUID, typeName, start, end string, days float64) {
	if h.notify == nil {
		return
	}

	// Requester display name for the subject line + their direct manager
	// so we can prioritise that person on the approval ping. Reporting
	// line is the canonical "ask them first" path; the broader admin
	// pool is the safety net for unset managers / managers on leave.
	var (
		requester string
		managerID *uuid.UUID
	)
	_ = h.db.QueryRow(ctx,
		`SELECT COALESCE(NULLIF(full_name,''), email::text), manager_id FROM users WHERE id=$1`, requesterID,
	).Scan(&requester, &managerID)

	recipients := []notifications.Recipient{}
	// Direct manager first — only if they're an active member. If their
	// row was disabled / deleted, fall through to the admin pool.
	if managerID != nil {
		var active bool
		_ = h.db.QueryRow(ctx,
			`SELECT status='active' AND deleted_at IS NULL FROM users WHERE id=$1`, *managerID,
		).Scan(&active)
		if active {
			id := *managerID
			recipients = append(recipients, notifications.Recipient{UserID: &id})
		}
	}

	// Anyone in the workspace whose role can approve at the manager
	// stage. Always queried so a manager-less user still gets approval
	// routed somewhere; the direct manager (if any) just sits at the
	// top of the recipient list.
	rows, err := h.db.Query(ctx, `
		SELECT DISTINCT u.id
		FROM users u
		JOIN user_roles ur ON ur.user_id = u.id
		JOIN roles r       ON r.id      = ur.role_id
		WHERE u.tenant_id=$1 AND u.deleted_at IS NULL AND u.status='active'
		  AND r.name IN ('super_admin','ceo','coo','delivery_manager','project_manager','line_manager')`,
		tid)
	if err != nil {
		// If we at least have the direct manager, fire to them and bail.
		if len(recipients) > 0 {
			h.notify.Notify(ctx, notifications.Event{
				Kind:       "leave.approval_needed",
				TenantID:   tid,
				Recipients: recipients,
				Payload: map[string]any{
					"Requester": requester,
					"Type":      typeName,
					"Days":      formatDays(days),
					"Start":     start,
					"End":       end,
				},
				DedupeKey: "leave.approval_needed:" + requestID.String(),
				Link:      "/leave",
			})
		}
		return
	}
	defer rows.Close()
	seen := map[uuid.UUID]bool{}
	for _, r := range recipients {
		if r.UserID != nil { seen[*r.UserID] = true }
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil && id != requesterID && !seen[id] {
			seen[id] = true
			recipients = append(recipients, notifications.Recipient{UserID: &id})
		}
	}
	if len(recipients) == 0 {
		return
	}

	h.notify.Notify(ctx, notifications.Event{
		Kind:       "leave.approval_needed",
		TenantID:   tid,
		Recipients: recipients,
		Payload: map[string]any{
			"Requester": requester,
			"Type":      typeName,
			"Days":      formatDays(days),
			"Start":     start,
			"End":       end,
		},
		DedupeKey: "leave.approval_needed:" + requestID.String(),
		Link:      "/leave",
	})
}

// formatDays trims a 0.5 to "0.5" and a 3.0 to "3" — purely cosmetic for
// notification subjects.
func formatDays(d float64) string {
	if d == float64(int(d)) {
		return fmt.Sprintf("%d", int(d))
	}
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.1f", d), "0"), ".")
}

// Decide — POST /api/v1/leave/requests/:id/decision  body: {decision, comment?}
// Two-stage workflow:
//   • approval_stage=manager_pending → only line-manager-class roles can act.
//     Approve → stage advances to hr_pending; reject → status=rejected.
//   • approval_stage=hr_pending      → only HR-class roles can act.
//     Approve → status=approved + balance debited; reject → status=rejected.
// super_admin can act at either stage. Every decision is appended to the
// approvals[] audit log.
func (h *Leave) Decide(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	actorRolesRaw, _ := c.Get(mw.CtxRoles)
	actorRoles, _ := actorRolesRaw.([]string)
	rid, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"}); return }
	var req struct {
		Decision string `json:"decision" binding:"required,oneof=approved rejected"`
		Comment  string `json:"comment"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()}); return
	}

	tx, err := h.db.Begin(c)
	if err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
	defer tx.Rollback(c)

	var (
		uid, typeID  uuid.UUID
		days         float64
		curStatus    string
		stage        string
		startDate    time.Time
		approvalsRaw []byte
	)
	if err := tx.QueryRow(c, `
		SELECT user_id, leave_type_id, days::float8, status, approval_stage, start_date, approvals
		  FROM leave_requests WHERE id=$1 AND tenant_id=$2`, rid, tid).
		Scan(&uid, &typeID, &days, &curStatus, &stage, &startDate, &approvalsRaw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "request not found"}); return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return
	}
	if curStatus != "pending" {
		c.JSON(http.StatusConflict, gin.H{"error": "Only pending requests can be decided.", "code": "not_pending"}); return
	}

	// Stage-role authority check.
	var stageLabel string
	switch stage {
	case "manager_pending":
		stageLabel = "manager"
		if !canApproveAsManager(actorRoles) {
			c.JSON(http.StatusForbidden, gin.H{
				"error": "This request is awaiting the line manager. Your role can't act on it yet.",
				"code":  "wrong_stage",
			}); return
		}
	case "hr_pending":
		stageLabel = "hr"
		if !canApproveAsHR(actorRoles) {
			c.JSON(http.StatusForbidden, gin.H{
				"error": "Manager has approved; HR sign-off is required next.",
				"code":  "wrong_stage",
			}); return
		}
	default:
		c.JSON(http.StatusConflict, gin.H{"error": "request not in an approvable stage", "code": "wrong_stage"}); return
	}

	// Append to the approvals audit log.
	var approvals []map[string]any
	_ = json.Unmarshal(approvalsRaw, &approvals)
	approvals = append(approvals, map[string]any{
		"stage":    stageLabel,
		"decision": req.Decision,
		"by":       actor,
		"at":       time.Now().UTC().Format(time.RFC3339),
		"comment":  strings.TrimSpace(req.Comment),
	})
	updatedApprovals, _ := json.Marshal(approvals)

	// Compute the next state.
	var nextStatus, nextStage string
	switch {
	case req.Decision == "rejected":
		nextStatus, nextStage = "rejected", "completed"
	case stage == "manager_pending":
		nextStatus, nextStage = "pending", "hr_pending"
	case stage == "hr_pending":
		nextStatus, nextStage = "approved", "completed"
	}

	if _, err := tx.Exec(c, `
		UPDATE leave_requests
		   SET status=$3, approval_stage=$4, approvals=$5::jsonb
		 WHERE id=$1 AND tenant_id=$2`,
		rid, tid, nextStatus, nextStage, string(updatedApprovals)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return
	}

	// Debit balance only on the final HR approval.
	if nextStatus == "approved" {
		if _, err := tx.Exec(c, `
			INSERT INTO leave_balances (tenant_id, user_id, leave_type_id, year, used_days)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (user_id, leave_type_id, year) DO UPDATE
			   SET used_days = leave_balances.used_days + EXCLUDED.used_days,
			       updated_at = now()`,
			tid, uid, typeID, startDate.Year(), days); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return
		}
	}

	if err := tx.Commit(c); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return
	}

	// Fan out notifications outside the transaction so a flaky email path
	// can't roll back a successful decision.
	go h.notifyDecision(context.Background(), tid, rid, uid, actor, req.Decision, strings.TrimSpace(req.Comment), nextStatus, nextStage, startDate, days)

	c.JSON(http.StatusOK, gin.H{"ok": true, "status": nextStatus, "approval_stage": nextStage})
}

// notifyDecision dispatches the right events after a decision lands.
//
//   • Rejection (any stage)         → ping the requester with the reason
//   • Final HR approval             → ping the requester with the window
//   • Manager-approved → hr_pending → ping HR-class folks to take the next step
//
// Best-effort; logged-only on failure.
func (h *Leave) notifyDecision(
	ctx context.Context,
	tid, requestID, requesterID, actorID uuid.UUID,
	decision, comment, nextStatus, nextStage string,
	startDate time.Time, days float64,
) {
	if h.notify == nil {
		return
	}

	// Pull the bits we need for templates in one query.
	var (
		requesterEmail, requesterName, actorName, typeName string
		end                                                time.Time
	)
	_ = h.db.QueryRow(ctx, `
		SELECT u.email::text, COALESCE(NULLIF(u.full_name,''), u.email::text),
		       lt.name, r.end_date,
		       COALESCE((SELECT NULLIF(full_name,'') FROM users WHERE id=$2), '')
		FROM leave_requests r
		JOIN users u  ON u.id = r.user_id
		JOIN leave_types lt ON lt.id = r.leave_type_id
		WHERE r.id=$1`,
		requestID, actorID,
	).Scan(&requesterEmail, &requesterName, &typeName, &end, &actorName)

	startStr := startDate.Format("2 Jan 2006")
	endStr := end.Format("2 Jan 2006")

	switch {
	case decision == "rejected":
		// Tell the requester with the reason inline.
		h.notify.Notify(ctx, notifications.Event{
			Kind:     "leave.rejected",
			TenantID: tid,
			Recipients: []notifications.Recipient{{UserID: &requesterID}},
			Payload: map[string]any{
				"Start":  startStr,
				"End":    endStr,
				"Type":   typeName,
				"Days":   formatDays(days),
				"Reason": fallback(comment, "No comment provided."),
				"Actor":  actorName,
			},
			DedupeKey: "leave.rejected:" + requestID.String(),
			Link:      "/leave",
		})
	case nextStatus == "approved":
		h.notify.Notify(ctx, notifications.Event{
			Kind:     "leave.approved",
			TenantID: tid,
			Recipients: []notifications.Recipient{{UserID: &requesterID}},
			Payload: map[string]any{
				"Start": startStr,
				"End":   endStr,
				"Type":  typeName,
				"Days":  formatDays(days),
				"Actor": actorName,
			},
			DedupeKey: "leave.approved:" + requestID.String(),
			Link:      "/leave",
		})
	case nextStage == "hr_pending":
		// Manager said yes — kick the next stage to HR.
		rows, err := h.db.Query(ctx, `
			SELECT DISTINCT u.id
			FROM users u
			JOIN user_roles ur ON ur.user_id = u.id
			JOIN roles r       ON r.id      = ur.role_id
			WHERE u.tenant_id=$1 AND u.deleted_at IS NULL AND u.status='active'
			  AND r.name IN ('super_admin','hr')`, tid)
		if err != nil {
			return
		}
		defer rows.Close()
		recipients := []notifications.Recipient{}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err == nil && id != requesterID {
				recipients = append(recipients, notifications.Recipient{UserID: &id})
			}
		}
		if len(recipients) == 0 {
			return
		}
		h.notify.Notify(ctx, notifications.Event{
			Kind:       "leave.approval_needed",
			TenantID:   tid,
			Recipients: recipients,
			Payload: map[string]any{
				"Requester": requesterName,
				"Type":      typeName,
				"Days":      formatDays(days),
				"Start":     startStr,
				"End":       endStr,
			},
			DedupeKey: "leave.approval_needed.hr:" + requestID.String(),
			Link:      "/leave",
		})
	}
}

func fallback(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

// Eligibility — GET /api/v1/leave/decision-authority
// Tiny helper the SPA uses to render the right Approve buttons for the current
// user. Returns which stages they can act on, so the UI doesn't show a button
// that the server will then reject.
func (h *Leave) DecisionAuthority(c *gin.Context) {
	rolesRaw, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesRaw.([]string)
	c.JSON(http.StatusOK, gin.H{
		"can_approve_manager": canApproveAsManager(roles),
		"can_approve_hr":      canApproveAsHR(roles),
	})
}

// MyPending — GET /api/v1/leave/my-pending
// Lightweight summary of the caller's most recent non-final leave request,
// used by the top-bar status menu so we can show "Awaiting line manager" or
// "Approved · starts in 3 days" next to the Apply-for-Leave action. Returns
// null when there's nothing live to show.
func (h *Leave) MyPending(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var (
		id                   uuid.UUID
		status, stage, typeN string
		start, end           time.Time
		days                 float64
	)
	// Pull the latest pending OR approved-but-not-yet-started request. Anything
	// rejected / cancelled / past is irrelevant to the live status surface.
	err := h.db.QueryRow(c, `
		SELECT r.id, r.status, r.approval_stage, lt.name, r.start_date, r.end_date, r.days::float8
		FROM leave_requests r
		JOIN leave_types lt ON lt.id = r.leave_type_id
		WHERE r.tenant_id=$1 AND r.user_id=$2
		  AND (r.status='pending' OR (r.status='approved' AND r.end_date >= CURRENT_DATE))
		ORDER BY r.submitted_at DESC
		LIMIT 1`, tid, uid).Scan(&id, &status, &stage, &typeN, &start, &end, &days)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"item": nil})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"item": gin.H{
			"id": id, "status": status, "approval_stage": stage,
			"type_name": typeN, "start_date": start, "end_date": end, "days": days,
		},
	})
}

// Cancel — POST /api/v1/leave/requests/:id/cancel
// Owner can cancel their own request at any time; managers/HR can cancel any.
// If the request was already approved, the balance is credited back.
func (h *Leave) Cancel(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rid, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"}); return }

	tx, err := h.db.Begin(c)
	if err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
	defer tx.Rollback(c)

	var (
		uid, typeID uuid.UUID
		days        float64
		curStatus   string
		startDate   time.Time
	)
	if err := tx.QueryRow(c, `
		SELECT user_id, leave_type_id, days::float8, status, start_date
		  FROM leave_requests WHERE id=$1 AND tenant_id=$2`, rid, tid).Scan(&uid, &typeID, &days, &curStatus, &startDate); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "request not found"}); return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return
	}
	if curStatus == "cancelled" || curStatus == "rejected" {
		c.JSON(http.StatusConflict, gin.H{"error": "Already " + curStatus}); return
	}
	if _, err := tx.Exec(c, `
		UPDATE leave_requests SET status='cancelled', decision_by=$3, decision_at=now()
		 WHERE id=$1 AND tenant_id=$2`, rid, tid, actor); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return
	}
	if curStatus == "approved" {
		if _, err := tx.Exec(c, `
			UPDATE leave_balances SET used_days = GREATEST(0, used_days - $5), updated_at = now()
			 WHERE tenant_id=$1 AND user_id=$2 AND leave_type_id=$3 AND year=$4`,
			tid, uid, typeID, startDate.Year(), days); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return
		}
	}
	if err := tx.Commit(c); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Delete — DELETE /api/v1/leave/requests/:id
// Hard-removes a leave row from the user's history. Only the owner can delete
// (managers/HR have Cancel which preserves the audit), and only when the
// request is already terminal (cancelled or rejected) — we never let a user
// erase an approved / in-flight request because that would silently put time
// back on the balance and break HR's audit trail.
func (h *Leave) Delete(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}

	var (
		ownerID uuid.UUID
		status  string
	)
	if err := h.db.QueryRow(c, `
		SELECT user_id, status FROM leave_requests
		WHERE id=$1 AND tenant_id=$2`, rid, tid).Scan(&ownerID, &status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "request not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if ownerID != uid {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the owner can delete their own request"})
		return
	}
	if status != "cancelled" && status != "rejected" {
		c.JSON(http.StatusConflict, gin.H{
			"error": "Only cancelled or rejected requests can be deleted. Cancel it first.",
		})
		return
	}
	if _, err := h.db.Exec(c, `DELETE FROM leave_requests WHERE id=$1 AND tenant_id=$2`, rid, tid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Dashboard — GET /api/v1/leave/dashboard
// One-shot bundle for the landing page: who's out today, upcoming approved
// requests, pending approvals queue, and the next 5 public holidays.
func (h *Leave) Dashboard(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	today := time.Now().UTC().Format("2006-01-02")

	on := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT r.id, COALESCE(u.full_name, ''), u.email::text, lt.name, r.start_date, r.end_date
		  FROM leave_requests r
		  JOIN users u       ON u.id = r.user_id
		  JOIN leave_types lt ON lt.id = r.leave_type_id
		 WHERE r.tenant_id=$1 AND r.status='approved'
		   AND $2::date BETWEEN r.start_date AND r.end_date
		 ORDER BY r.start_date`, tid, today); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				id uuid.UUID
				name, email, typeName string
				start, end time.Time
			)
			if err := rows.Scan(&id, &name, &email, &typeName, &start, &end); err == nil {
				on = append(on, gin.H{
					"id": id, "user_name": name, "user_email": email, "type_name": typeName,
					"start_date": start.Format("2006-01-02"), "end_date": end.Format("2006-01-02"),
				})
			}
		}
	}

	upcoming := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT r.id, COALESCE(u.full_name, ''), u.email::text, lt.name, r.start_date, r.end_date, r.days::float8
		  FROM leave_requests r
		  JOIN users u       ON u.id = r.user_id
		  JOIN leave_types lt ON lt.id = r.leave_type_id
		 WHERE r.tenant_id=$1 AND r.status='approved' AND r.start_date > $2::date
		 ORDER BY r.start_date
		 LIMIT 10`, tid, today); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				id uuid.UUID
				name, email, typeName string
				start, end time.Time
				days float64
			)
			if err := rows.Scan(&id, &name, &email, &typeName, &start, &end, &days); err == nil {
				upcoming = append(upcoming, gin.H{
					"id": id, "user_name": name, "user_email": email, "type_name": typeName,
					"start_date": start.Format("2006-01-02"), "end_date": end.Format("2006-01-02"), "days": days,
				})
			}
		}
	}

	pending := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT r.id, COALESCE(u.full_name, ''), u.email::text, lt.name,
		       r.start_date, r.end_date, r.days::float8, r.reason, r.submitted_at, r.approval_stage
		  FROM leave_requests r
		  JOIN users u       ON u.id = r.user_id
		  JOIN leave_types lt ON lt.id = r.leave_type_id
		 WHERE r.tenant_id=$1 AND r.status='pending'
		 ORDER BY r.submitted_at`, tid); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				id uuid.UUID
				name, email, typeName, reason, stage string
				start, end time.Time
				days float64
				submitted any
			)
			if err := rows.Scan(&id, &name, &email, &typeName, &start, &end, &days, &reason, &submitted, &stage); err == nil {
				pending = append(pending, gin.H{
					"id": id, "user_name": name, "user_email": email, "type_name": typeName,
					"start_date": start.Format("2006-01-02"), "end_date": end.Format("2006-01-02"),
					"days": days, "reason": reason, "submitted_at": submitted,
					"approval_stage": stage,
				})
			}
		}
	}

	holidays := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT id, observed_on, name FROM public_holidays
		 WHERE tenant_id=$1 AND observed_on >= $2::date
		 ORDER BY observed_on LIMIT 10`, tid, today); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			var d time.Time
			var name string
			if err := rows.Scan(&id, &d, &name); err == nil {
				holidays = append(holidays, gin.H{
					"id": id, "observed_on": d.Format("2006-01-02"), "name": name,
				})
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"on_leave_today":     on,
		"upcoming":           upcoming,
		"pending_approvals":  pending,
		"upcoming_holidays":  holidays,
		"as_of":              time.Now().Format(time.RFC3339),
	})
}

// PublicHolidays — GET /api/v1/leave/public-holidays?year=
func (h *Leave) PublicHolidays(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	yearQ := c.Query("year")
	if yearQ == "" { yearQ = strings.Replace(time.Now().Format("2006"), " ", "", -1) }

	rows, err := h.db.Query(c, `
		SELECT id, observed_on, name
		  FROM public_holidays
		 WHERE tenant_id=$1 AND EXTRACT(YEAR FROM observed_on) = $2::int
		 ORDER BY observed_on`, tid, yearQ)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id uuid.UUID
		var d time.Time
		var name string
		if err := rows.Scan(&id, &d, &name); err == nil {
			out = append(out, gin.H{"id": id, "observed_on": d.Format("2006-01-02"), "name": name})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// AddPublicHoliday — POST /api/v1/leave/public-holidays  body: {observed_on, name}
func (h *Leave) AddPublicHoliday(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var req struct {
		ObservedOn string `json:"observed_on" binding:"required"`
		Name       string `json:"name"        binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var id uuid.UUID
	if err := h.db.QueryRow(c, `
		INSERT INTO public_holidays (tenant_id, observed_on, name)
		VALUES ($1, $2::date, $3)
		ON CONFLICT (tenant_id, observed_on, name) DO UPDATE SET name = EXCLUDED.name
		RETURNING id`, tid, req.ObservedOn, strings.TrimSpace(req.Name)).Scan(&id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

// Calendar — GET /api/v1/leave/calendar?from=&to=
// All approved requests within the window — used by the team availability view.
func (h *Leave) Calendar(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	from := c.Query("from"); if from == "" { from = time.Now().Format("2006-01-02") }
	to   := c.Query("to");   if to   == "" { to = time.Now().AddDate(0, 2, 0).Format("2006-01-02") }

	rows, err := h.db.Query(c, `
		SELECT r.id, r.user_id, COALESCE(u.full_name, ''), u.email::text,
		       lt.code, lt.name, r.start_date, r.end_date, r.days::float8, r.status
		  FROM leave_requests r
		  JOIN users u        ON u.id = r.user_id
		  JOIN leave_types lt ON lt.id = r.leave_type_id
		 WHERE r.tenant_id=$1
		   AND r.status IN ('approved','pending')
		   AND r.start_date <= $3::date AND r.end_date >= $2::date
		 ORDER BY r.start_date`, tid, from, to)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id, uid               uuid.UUID
			name, email, code, ln string
			start, end            time.Time
			days                  float64
			status                string
		)
		if err := rows.Scan(&id, &uid, &name, &email, &code, &ln, &start, &end, &days, &status); err == nil {
			out = append(out, gin.H{
				"id": id, "user_id": uid, "user_name": name, "user_email": email,
				"code": code, "type_name": ln,
				"start_date": start.Format("2006-01-02"), "end_date": end.Format("2006-01-02"),
				"days": days, "status": status,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out, "from": from, "to": to})
}

// workingDays = inclusive weekday count between start..end. Public holidays not
// subtracted in this MVP — the operator can adjust on approval.
func workingDays(start, end time.Time) float64 {
	if end.Before(start) { return 0 }
	count := 0
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		w := d.Weekday()
		if w != time.Saturday && w != time.Sunday {
			count++
		}
	}
	return float64(count)
}
