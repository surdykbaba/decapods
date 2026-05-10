package handlers

import (
	"errors"
	"net/http"
	"strings"
	"time"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Leave struct{ db *pgxpool.Pool }

func NewLeave(db *pgxpool.Pool) *Leave { return &Leave{db: db} }

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
// scope=mine returns the caller's own requests; scope=team returns every request
// in the tenant (used by managers/HR). Defaults to mine.
func (h *Leave) ListRequests(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	scope := c.Query("scope")
	if scope != "team" { scope = "mine" }

	args := []any{tid}
	q := `SELECT r.id, r.user_id, COALESCE(u.full_name,''), COALESCE(u.email::text,''),
	             r.leave_type_id, lt.code, lt.name, lt.paid,
	             r.start_date, r.end_date, r.days::float8, r.reason, r.handover_notes,
	             r.backup_user_id, COALESCE(bu.full_name, ''),
	             r.status, r.decision_by, COALESCE(du.full_name, ''),
	             r.decision_at, r.decision_comment, r.submitted_at, r.created_at
	        FROM leave_requests r
	        JOIN users u   ON u.id = r.user_id
	        JOIN leave_types lt ON lt.id = r.leave_type_id
	        LEFT JOIN users bu ON bu.id = r.backup_user_id
	        LEFT JOIN users du ON du.id = r.decision_by
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
			id, userID, typeID                                                    uuid.UUID
			backupID, decisionBy                                                  *uuid.UUID
			userName, userEmail, code, typeName, reason, handover, backupName    string
			status, decisionName, decisionComment                                 string
			paid                                                                  bool
			start, end                                                            time.Time
			decisionAt                                                            *time.Time
			submittedAt, createdAt                                                any
			days                                                                  float64
		)
		if err := rows.Scan(&id, &userID, &userName, &userEmail, &typeID, &code, &typeName, &paid,
			&start, &end, &days, &reason, &handover, &backupID, &backupName,
			&status, &decisionBy, &decisionName, &decisionAt, &decisionComment, &submittedAt, &createdAt); err == nil {
			out = append(out, gin.H{
				"id": id, "user_id": userID, "user_name": userName, "user_email": userEmail,
				"leave_type_id": typeID, "code": code, "type_name": typeName, "paid": paid,
				"start_date": start.Format("2006-01-02"),
				"end_date":   end.Format("2006-01-02"),
				"days":       days, "reason": reason, "handover_notes": handover,
				"backup_user_id": backupID, "backup_user_name": backupName,
				"status": status, "decision_by": decisionBy, "decision_by_name": decisionName,
				"decision_at": decisionAt, "decision_comment": decisionComment,
				"submitted_at": submittedAt, "created_at": createdAt,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// CreateRequest — POST /api/v1/leave/requests
func (h *Leave) CreateRequest(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		LeaveTypeID  string  `json:"leave_type_id" binding:"required,uuid"`
		StartDate    string  `json:"start_date"    binding:"required"`
		EndDate      string  `json:"end_date"      binding:"required"`
		Reason       string  `json:"reason"`
		HandoverNotes string `json:"handover_notes"`
		BackupUserID string  `json:"backup_user_id"`
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

	// Validate the type exists for this tenant.
	var typeName string
	if err := h.db.QueryRow(c, `SELECT name FROM leave_types WHERE id=$1 AND tenant_id=$2 AND active=true`, typeID, tid).Scan(&typeName); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown leave type"}); return
	}

	var backupID *uuid.UUID
	if strings.TrimSpace(req.BackupUserID) != "" {
		b, err := uuid.Parse(req.BackupUserID)
		if err != nil { c.JSON(http.StatusBadRequest, gin.H{"error": "bad backup_user_id"}); return }
		backupID = &b
	}

	days := workingDays(start, end)
	var id uuid.UUID
	if err := h.db.QueryRow(c, `
		INSERT INTO leave_requests (tenant_id, user_id, leave_type_id, start_date, end_date, days,
		                            reason, handover_notes, backup_user_id, status)
		VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,'pending')
		RETURNING id`,
		tid, uid, typeID, req.StartDate, req.EndDate, days,
		strings.TrimSpace(req.Reason), strings.TrimSpace(req.HandoverNotes), backupID).Scan(&id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id, "days": days})
}

// Decide — POST /api/v1/leave/requests/:id/decision  body: {decision:"approved"|"rejected", comment?}
func (h *Leave) Decide(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
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
		startDate    time.Time
	)
	if err := tx.QueryRow(c, `
		SELECT user_id, leave_type_id, days::float8, status, start_date
		  FROM leave_requests WHERE id=$1 AND tenant_id=$2`, rid, tid).Scan(&uid, &typeID, &days, &curStatus, &startDate); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "request not found"}); return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return
	}
	if curStatus != "pending" {
		c.JSON(http.StatusConflict, gin.H{"error": "Only pending requests can be decided.", "code": "not_pending"}); return
	}

	if _, err := tx.Exec(c, `
		UPDATE leave_requests
		   SET status=$3, decision_by=$4, decision_at=now(), decision_comment=$5
		 WHERE id=$1 AND tenant_id=$2`,
		rid, tid, req.Decision, actor, strings.TrimSpace(req.Comment)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return
	}

	// On approval, debit the balance for the start year of the request.
	if req.Decision == "approved" {
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
	c.JSON(http.StatusOK, gin.H{"ok": true})
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
		       r.start_date, r.end_date, r.days::float8, r.reason, r.submitted_at
		  FROM leave_requests r
		  JOIN users u       ON u.id = r.user_id
		  JOIN leave_types lt ON lt.id = r.leave_type_id
		 WHERE r.tenant_id=$1 AND r.status='pending'
		 ORDER BY r.submitted_at`, tid); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				id uuid.UUID
				name, email, typeName, reason string
				start, end time.Time
				days float64
				submitted any
			)
			if err := rows.Scan(&id, &name, &email, &typeName, &start, &end, &days, &reason, &submitted); err == nil {
				pending = append(pending, gin.H{
					"id": id, "user_name": name, "user_email": email, "type_name": typeName,
					"start_date": start.Format("2006-01-02"), "end_date": end.Format("2006-01-02"),
					"days": days, "reason": reason, "submitted_at": submitted,
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
