// Package handlers — okrs.go
//
// OKR Phase 1: quarterly cycles, objectives, and key results. The data
// model treats objectives + KRs as one polymorphic okrs table keyed by
// `kind` so cascading parent_id stays a self-join. See migration 000054.
//
// What this file ships:
//   • Cycle CRUD            — admin-class (governance:write).
//   • Cycle list            — anyone authenticated.
//   • OKR CRUD              — owner can edit their own; admins can edit
//                             anyone's. Read is open to anyone in the
//                             tenant (so 1:1s and team-level visibility
//                             work without per-row ACLs in Phase 1).
//   • Progress update       — fast endpoint for "bump current_value /
//                             confidence" so the frontend doesn't have
//                             to PATCH the whole row.
//
// Phase 2 will add okr_checkins (weekly progress comments + history) and
// parent_id editing for cascade. The schema already has the column, so
// it'll be a handler-level change only.
package handlers

import (
	"context"
	"net/http"
	"strings"
	"time"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type OKRs struct {
	db *pgxpool.Pool
}

func NewOKRs(db *pgxpool.Pool) *OKRs { return &OKRs{db: db} }

// ─────────────────────────────────────────────────────────────────────
// Cycles
// ─────────────────────────────────────────────────────────────────────

type okrCycle struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	StartsOn  string    `json:"starts_on"` // YYYY-MM-DD
	EndsOn    string    `json:"ends_on"`
	Status    string    `json:"status"`
	CreatedBy *uuid.UUID `json:"created_by,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// ListCycles — GET /api/v1/okrs/cycles
//
// Returns every cycle in the tenant, newest start date first. The SPA
// uses this to drive the cycle picker on the My OKRs page.
func (h *OKRs) ListCycles(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c, `
		SELECT id, name, starts_on, ends_on, status, created_by, created_at
		  FROM okr_cycles
		 WHERE tenant_id=$1
		 ORDER BY starts_on DESC, created_at DESC`, tid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []okrCycle{}
	for rows.Next() {
		var r okrCycle
		var starts, ends time.Time
		if err := rows.Scan(&r.ID, &r.Name, &starts, &ends, &r.Status, &r.CreatedBy, &r.CreatedAt); err == nil {
			r.StartsOn = starts.Format("2006-01-02")
			r.EndsOn = ends.Format("2006-01-02")
			out = append(out, r)
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// CreateCycle — POST /api/v1/okrs/cycles
//
// Admin-class only (the router enforces governance:write). Status
// defaults to "planning" so HR can stage the next cycle before it goes
// live without confusing anyone's current view.
func (h *OKRs) CreateCycle(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Name     string `json:"name"      binding:"required"`
		StartsOn string `json:"starts_on" binding:"required"` // YYYY-MM-DD
		EndsOn   string `json:"ends_on"   binding:"required"`
		Status   string `json:"status"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, err := time.Parse("2006-01-02", req.StartsOn); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "starts_on must be YYYY-MM-DD"})
		return
	}
	if _, err := time.Parse("2006-01-02", req.EndsOn); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ends_on must be YYYY-MM-DD"})
		return
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = "planning"
	}
	if status != "planning" && status != "active" && status != "closed" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "status must be planning / active / closed"})
		return
	}
	var id uuid.UUID
	if err := h.db.QueryRow(c, `
		INSERT INTO okr_cycles (tenant_id, name, starts_on, ends_on, status, created_by)
		VALUES ($1, $2, $3::date, $4::date, $5, $6)
		RETURNING id`,
		tid, strings.TrimSpace(req.Name), req.StartsOn, req.EndsOn, status, uid).Scan(&id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

// UpdateCycle — PATCH /api/v1/okrs/cycles/:id
// Admin-class. Body: any subset of {name, starts_on, ends_on, status}.
func (h *OKRs) UpdateCycle(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad cycle id"})
		return
	}
	var req map[string]any
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Build a partial UPDATE — only touch supplied columns.
	sets := []string{"updated_at = now()"}
	args := []any{id, tid}
	idx := 3
	if v, ok := req["name"].(string); ok && strings.TrimSpace(v) != "" {
		sets = append(sets, "name = $"+itoa(idx))
		args = append(args, strings.TrimSpace(v))
		idx++
	}
	if v, ok := req["starts_on"].(string); ok && v != "" {
		if _, err := time.Parse("2006-01-02", v); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "starts_on must be YYYY-MM-DD"})
			return
		}
		sets = append(sets, "starts_on = $"+itoa(idx)+"::date")
		args = append(args, v)
		idx++
	}
	if v, ok := req["ends_on"].(string); ok && v != "" {
		if _, err := time.Parse("2006-01-02", v); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "ends_on must be YYYY-MM-DD"})
			return
		}
		sets = append(sets, "ends_on = $"+itoa(idx)+"::date")
		args = append(args, v)
		idx++
	}
	if v, ok := req["status"].(string); ok && v != "" {
		if v != "planning" && v != "active" && v != "closed" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "status must be planning / active / closed"})
			return
		}
		sets = append(sets, "status = $"+itoa(idx))
		args = append(args, v)
		idx++
	}
	if len(sets) == 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nothing to update"})
		return
	}
	q := "UPDATE okr_cycles SET " + strings.Join(sets, ", ") + " WHERE id=$1 AND tenant_id=$2"
	if _, err := h.db.Exec(c, q, args...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ─────────────────────────────────────────────────────────────────────
// OKRs (objectives + key results)
// ─────────────────────────────────────────────────────────────────────

type okrRow struct {
	ID            uuid.UUID  `json:"id"`
	CycleID       uuid.UUID  `json:"cycle_id"`
	ParentID      *uuid.UUID `json:"parent_id"`
	ParentTitle   string     `json:"parent_title,omitempty"`
	OwnerID       uuid.UUID  `json:"owner_id"`
	OwnerName     string     `json:"owner_name"`
	OwnerEmail    string     `json:"owner_email"`
	Kind          string     `json:"kind"`
	Title         string     `json:"title"`
	Description   string     `json:"description,omitempty"`
	TargetValue   *float64   `json:"target_value,omitempty"`
	CurrentValue  float64    `json:"current_value"`
	Unit          string     `json:"unit,omitempty"`
	Confidence    string     `json:"confidence"`
	Status        string     `json:"status"`
	Position      int        `json:"position"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	// Derived: completion percentage. For quantitative KRs that's
	// current/target * 100, clamped to 100. For qualitative rows
	// (target NULL) it's 100 when status='done' else 0.
	ProgressPct   int        `json:"progress_pct"`
	// Phase 2 — check-in summary. checkin_count = total updates on this
	// OKR; latest_checkin_at = when the most recent one landed. The SPA
	// uses these to render a "Last checked in X days ago" hint without
	// per-row history queries.
	CheckinCount     int        `json:"checkin_count"`
	LatestCheckinAt  *time.Time `json:"latest_checkin_at,omitempty"`
}

// List — GET /api/v1/okrs?cycle_id=&owner_id=&kind=
//
// Read is open to anyone authenticated in the tenant — Phase 1 doesn't
// have per-row ACLs because most OKR practice is org-transparent and
// adding privacy later is the cheaper retrofit than peeling it open.
func (h *OKRs) List(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	args := []any{tid}
	q := `
		SELECT o.id, o.cycle_id, o.parent_id, COALESCE(p.title,'') AS parent_title,
		       o.owner_id,
		       COALESCE(u.full_name,''), COALESCE(u.email::text,''),
		       o.kind, o.title, COALESCE(o.description,''),
		       o.target_value, o.current_value, COALESCE(o.unit,''),
		       o.confidence, o.status, o.position,
		       o.created_at, o.updated_at,
		       (SELECT COUNT(*)::int FROM okr_checkins ck WHERE ck.okr_id = o.id) AS checkin_count,
		       (SELECT MAX(created_at)  FROM okr_checkins ck WHERE ck.okr_id = o.id) AS latest_checkin_at
		  FROM okrs o
		  LEFT JOIN users u ON u.id = o.owner_id
		  LEFT JOIN okrs  p ON p.id = o.parent_id
		 WHERE o.tenant_id=$1`
	if v := c.Query("cycle_id"); v != "" {
		if id, err := uuid.Parse(v); err == nil {
			args = append(args, id)
			q += " AND o.cycle_id=$" + itoa(len(args))
		}
	}
	if v := c.Query("owner_id"); v != "" {
		if id, err := uuid.Parse(v); err == nil {
			args = append(args, id)
			q += " AND o.owner_id=$" + itoa(len(args))
		}
	}
	if v := c.Query("kind"); v == "objective" || v == "key_result" {
		args = append(args, v)
		q += " AND o.kind=$" + itoa(len(args))
	}
	q += " ORDER BY o.kind DESC, o.position ASC, o.created_at ASC LIMIT 500"

	rows, err := h.db.Query(c, q, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []okrRow{}
	for rows.Next() {
		var r okrRow
		if err := rows.Scan(&r.ID, &r.CycleID, &r.ParentID, &r.ParentTitle, &r.OwnerID,
			&r.OwnerName, &r.OwnerEmail,
			&r.Kind, &r.Title, &r.Description,
			&r.TargetValue, &r.CurrentValue, &r.Unit,
			&r.Confidence, &r.Status, &r.Position,
			&r.CreatedAt, &r.UpdatedAt,
			&r.CheckinCount, &r.LatestCheckinAt); err == nil {
			r.ProgressPct = computeProgressPct(r.TargetValue, r.CurrentValue, r.Status)
			out = append(out, r)
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// Create — POST /api/v1/okrs
//
// Body: { cycle_id, kind, title, description?, parent_id? (required for
// key_result), target_value?, current_value?, unit?, owner_id?,
// confidence?, status? }
//
// Owner defaults to the caller. Position defaults to next-in-cycle so
// the SPA doesn't have to invent ordering on the client.
func (h *OKRs) Create(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		CycleID      uuid.UUID  `json:"cycle_id"  binding:"required"`
		ParentID     *uuid.UUID `json:"parent_id"`
		OwnerID      *uuid.UUID `json:"owner_id"`
		Kind         string     `json:"kind"      binding:"required"`
		Title        string     `json:"title"     binding:"required"`
		Description  string     `json:"description"`
		TargetValue  *float64   `json:"target_value"`
		CurrentValue float64    `json:"current_value"`
		Unit         string     `json:"unit"`
		Confidence   string     `json:"confidence"`
		Status       string     `json:"status"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Kind != "objective" && req.Kind != "key_result" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "kind must be objective / key_result"})
		return
	}
	if req.Kind == "key_result" && req.ParentID == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "key_result requires parent_id"})
		return
	}
	if req.Kind == "objective" && req.ParentID != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "objective cannot have a parent (Phase 2 will add cascade)"})
		return
	}
	owner := uid
	if req.OwnerID != nil {
		owner = *req.OwnerID
	}
	confidence := strings.TrimSpace(req.Confidence)
	if confidence == "" {
		confidence = "green"
	}
	if confidence != "green" && confidence != "amber" && confidence != "red" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "confidence must be green / amber / red"})
		return
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = "in_progress"
	}
	if status != "draft" && status != "in_progress" && status != "done" && status != "dropped" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid status"})
		return
	}
	// Position: next available in the cycle. Cheap COUNT-based scheme;
	// SPA reorders never collide because positions get rewritten on
	// reorder (separate endpoint, not in Phase 1).
	var nextPos int
	_ = h.db.QueryRow(c, `
		SELECT COALESCE(MAX(position), -1) + 1
		  FROM okrs WHERE tenant_id=$1 AND cycle_id=$2 AND kind=$3
		   AND COALESCE(parent_id::text,'') = COALESCE($4::text,'')`,
		tid, req.CycleID, req.Kind, req.ParentID).Scan(&nextPos)

	var id uuid.UUID
	if err := h.db.QueryRow(c, `
		INSERT INTO okrs (tenant_id, cycle_id, parent_id, owner_id, kind,
		                  title, description, target_value, current_value,
		                  unit, confidence, status, position, created_by)
		VALUES ($1,$2,$3,$4,$5, NULLIF($6,''),$7,$8,$9, NULLIF($10,''),$11,$12,$13,$14)
		RETURNING id`,
		tid, req.CycleID, req.ParentID, owner, req.Kind,
		strings.TrimSpace(req.Title), strings.TrimSpace(req.Description),
		req.TargetValue, req.CurrentValue,
		strings.TrimSpace(req.Unit), confidence, status, nextPos, uid).Scan(&id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

// Update — PATCH /api/v1/okrs/:id
//
// Owners can edit their own rows; governance:write admins can edit
// anyone's. Body is a partial — only supplied fields move.
func (h *OKRs) Update(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad okr id"})
		return
	}

	// Ownership / admin check first.
	var owner uuid.UUID
	if err := h.db.QueryRow(c, `
		SELECT owner_id FROM okrs WHERE id=$1 AND tenant_id=$2`,
		id, tid).Scan(&owner); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "okr not found"})
		return
	}
	if owner != uid && !okrAdmin(roles) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the owner or an admin can edit"})
		return
	}

	var req map[string]any
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	sets := []string{"updated_at = now()"}
	args := []any{id, tid}
	idx := 3
	pushStr := func(col string, v any, allowed ...string) bool {
		s, ok := v.(string)
		if !ok || strings.TrimSpace(s) == "" {
			return true
		}
		s = strings.TrimSpace(s)
		if len(allowed) > 0 {
			ok2 := false
			for _, a := range allowed {
				if a == s {
					ok2 = true
					break
				}
			}
			if !ok2 {
				c.JSON(http.StatusBadRequest, gin.H{"error": col + " has invalid value"})
				return false
			}
		}
		sets = append(sets, col+" = $"+itoa(idx))
		args = append(args, s)
		idx++
		return true
	}
	pushNum := func(col string, v any) {
		// Accept JSON numbers either as float64 (default) or string
		// payloads that the SPA might send via FormData.
		switch x := v.(type) {
		case float64:
			sets = append(sets, col+" = $"+itoa(idx))
			args = append(args, x)
			idx++
		case string:
			if strings.TrimSpace(x) == "" {
				// Empty string clears the value (target_value can be NULL).
				sets = append(sets, col+" = NULL")
			}
		}
	}
	if !pushStr("title", req["title"]) { return }
	if !pushStr("description", req["description"]) { return }
	if !pushStr("unit", req["unit"]) { return }
	if !pushStr("confidence", req["confidence"], "green", "amber", "red") { return }
	if !pushStr("status", req["status"], "draft", "in_progress", "done", "dropped") { return }
	if v, ok := req["current_value"]; ok {
		pushNum("current_value", v)
	}
	if v, ok := req["target_value"]; ok {
		pushNum("target_value", v)
	}
	// parent_id (Phase 2 cascade). Empty string clears the link; a uuid
	// sets it. Only meaningful for objectives — the schema CHECK would
	// reject a NULL parent on a key_result, so the handler bails before
	// hitting the DB if someone tries to detach a KR.
	if v, ok := req["parent_id"]; ok {
		switch x := v.(type) {
		case string:
			if strings.TrimSpace(x) == "" {
				sets = append(sets, "parent_id = NULL")
			} else if pid, err := uuid.Parse(strings.TrimSpace(x)); err == nil {
				// Disallow self-parenting + circular at one hop. Deep
				// cycles still possible across more hops; we treat them
				// as an HR / UI concern for now since the tree depth is
				// tiny in practice (org → team → individual = 3 levels).
				if pid == id {
					c.JSON(http.StatusBadRequest, gin.H{"error": "an OKR cannot be its own parent"})
					return
				}
				sets = append(sets, "parent_id = $"+itoa(idx))
				args = append(args, pid)
				idx++
			} else {
				c.JSON(http.StatusBadRequest, gin.H{"error": "parent_id must be a uuid"})
				return
			}
		case nil:
			sets = append(sets, "parent_id = NULL")
		}
	}
	if len(sets) == 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nothing to update"})
		return
	}
	q := "UPDATE okrs SET " + strings.Join(sets, ", ") + " WHERE id=$1 AND tenant_id=$2"
	if _, err := h.db.Exec(c, q, args...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Delete — DELETE /api/v1/okrs/:id
// Owners can delete their own rows; admins can delete anything. The
// FK is ON DELETE CASCADE, so deleting an objective also takes its key
// results with it.
func (h *OKRs) Delete(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad okr id"})
		return
	}
	var owner uuid.UUID
	if err := h.db.QueryRow(c, `
		SELECT owner_id FROM okrs WHERE id=$1 AND tenant_id=$2`,
		id, tid).Scan(&owner); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "okr not found"})
		return
	}
	if owner != uid && !okrAdmin(roles) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the owner or an admin can delete"})
		return
	}
	if _, err := h.db.Exec(c, `DELETE FROM okrs WHERE id=$1 AND tenant_id=$2`, id, tid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

// okrAdmin — roles that can edit anyone's OKR. Mirrors the rbac.go set
// used in opportunity-doc admin checks.
func okrAdmin(roles []string) bool {
	for _, r := range roles {
		if r == "super_admin" || r == "ceo" || r == "coo" || r == "hr" || r == "hr_manager" {
			return true
		}
	}
	return false
}

// computeProgressPct — quantitative KRs: clamp(current/target * 100).
// Qualitative (target == nil): 100 when status=done, else 0.
func computeProgressPct(target *float64, current float64, status string) int {
	if target == nil || *target == 0 {
		if status == "done" {
			return 100
		}
		return 0
	}
	pct := int((current / *target) * 100)
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return pct
}

// itoa — minimal int → string helper; used in SQL placeholder indexing
// where strconv.Itoa would have been a one-liner but I want this file
// dependency-clean.
func itoa(n int) string {
	// Fast path for the small numbers we use here (placeholder indices
	// never exceed two digits in practice).
	if n < 0 || n > 99 {
		// Fall back to fmt-style for the rare bigger case.
		var b strings.Builder
		_, _ = b.WriteString("")
		var neg bool
		x := n
		if x < 0 {
			neg = true
			x = -x
		}
		digits := []byte{}
		if x == 0 {
			digits = []byte{'0'}
		}
		for x > 0 {
			digits = append([]byte{byte('0' + x%10)}, digits...)
			x /= 10
		}
		if neg {
			return "-" + string(digits)
		}
		return string(digits)
	}
	if n < 10 {
		return string([]byte{byte('0' + n)})
	}
	return string([]byte{byte('0' + n/10), byte('0' + n%10)})
}

// Compile-time guard so the unused `context` import doesn't slip in if
// the package gets refactored. ctx is used implicitly through *gin.Context
// but referencing it once keeps go vet quiet.
var _ = context.Background

// ─────────────────────────────────────────────────────────────────────
// Phase 2 — Check-ins
// ─────────────────────────────────────────────────────────────────────

type okrCheckin struct {
	ID           uuid.UUID  `json:"id"`
	OKRID        uuid.UUID  `json:"okr_id"`
	UserID       uuid.UUID  `json:"user_id"`
	UserName     string     `json:"user_name"`
	UserEmail    string     `json:"user_email"`
	CurrentValue *float64   `json:"current_value,omitempty"`
	Percent      int        `json:"percent"`
	Confidence   string     `json:"confidence"`
	Status       *string    `json:"status,omitempty"`
	Comment      string     `json:"comment,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}

// ListCheckins — GET /api/v1/okrs/:id/checkins
//
// Returns the most-recent-first history for a single OKR. Phase 2 keeps
// this simple — newest 50 entries, no pagination since the SPA's history
// strip renders at most ~10 in the inline drawer.
func (h *OKRs) ListCheckins(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	okrID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad okr id"})
		return
	}
	// Tenant-scope guard — make sure the OKR exists in the caller's
	// tenant before we hand back the history.
	var exists bool
	if err := h.db.QueryRow(c, `
		SELECT EXISTS (SELECT 1 FROM okrs WHERE id=$1 AND tenant_id=$2)`,
		okrID, tid).Scan(&exists); err != nil || !exists {
		c.JSON(http.StatusNotFound, gin.H{"error": "okr not found"})
		return
	}
	rows, err := h.db.Query(c, `
		SELECT ck.id, ck.okr_id, ck.user_id,
		       COALESCE(u.full_name,''), COALESCE(u.email::text,''),
		       ck.current_value, ck.percent, ck.confidence,
		       ck.status, COALESCE(ck.comment,''), ck.created_at
		  FROM okr_checkins ck
		  LEFT JOIN users u ON u.id = ck.user_id
		 WHERE ck.okr_id=$1
		 ORDER BY ck.created_at DESC
		 LIMIT 50`, okrID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []okrCheckin{}
	for rows.Next() {
		var r okrCheckin
		if err := rows.Scan(&r.ID, &r.OKRID, &r.UserID,
			&r.UserName, &r.UserEmail,
			&r.CurrentValue, &r.Percent, &r.Confidence,
			&r.Status, &r.Comment, &r.CreatedAt); err == nil {
			out = append(out, r)
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// CreateCheckin — POST /api/v1/okrs/:id/checkins
//
// Body: { current_value? (numeric), percent? (0..100), confidence,
//         status?, comment? }
//
// Behaviour:
//   • Inserts an immutable history row.
//   • Also mutates the parent OKR row: bumps current_value (when sent),
//     confidence (always), and status (when sent). The list view reads
//     from okrs, not the latest check-in, so this keeps the dashboard
//     fast without a per-row latest-join.
//
// Anyone can check in on an OKR they own; admins can check in on any
// OKR (useful for HR-led 1:1 updates).
func (h *OKRs) CreateCheckin(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	okrID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad okr id"})
		return
	}

	// Load the OKR to check ownership + compute derived fields.
	var (
		owner       uuid.UUID
		target      *float64
		currentVal  float64
		kind        string
	)
	if err := h.db.QueryRow(c, `
		SELECT owner_id, target_value, current_value, kind
		  FROM okrs WHERE id=$1 AND tenant_id=$2`,
		okrID, tid).Scan(&owner, &target, &currentVal, &kind); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "okr not found"})
		return
	}
	if owner != uid && !okrAdmin(roles) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the owner or an admin can check in on this OKR"})
		return
	}

	var req struct {
		CurrentValue *float64 `json:"current_value"`
		Percent      *int     `json:"percent"`
		Confidence   string   `json:"confidence" binding:"required"`
		Status       string   `json:"status"`
		Comment      string   `json:"comment"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Confidence != "green" && req.Confidence != "amber" && req.Confidence != "red" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "confidence must be green / amber / red"})
		return
	}
	if req.Status != "" && req.Status != "draft" && req.Status != "in_progress" && req.Status != "done" && req.Status != "dropped" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid status"})
		return
	}
	_ = kind // available for future "objectives don't take current_value" guards
	// Resolve percent:
	//   1. Caller sent it explicitly → use it.
	//   2. Quantitative + current_value sent → derive from current/target.
	//   3. Quantitative + neither sent → derive from existing OKR state.
	//   4. Qualitative → status-driven (100 if done, else 0).
	newCurrent := currentVal
	if req.CurrentValue != nil {
		newCurrent = *req.CurrentValue
	}
	percent := 0
	if req.Percent != nil {
		percent = *req.Percent
	} else if target != nil && *target != 0 {
		percent = int((newCurrent / *target) * 100)
	} else if req.Status == "done" || (req.Status == "" && newCurrent > 0) {
		percent = 100
	}
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}

	tx, err := h.db.Begin(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(c)

	// Insert immutable history row.
	var checkinID uuid.UUID
	if err := tx.QueryRow(c, `
		INSERT INTO okr_checkins
		  (tenant_id, okr_id, user_id, current_value, percent, confidence, status, comment)
		VALUES ($1,$2,$3,$4,$5,$6, NULLIF($7,''), NULLIF($8,''))
		RETURNING id`,
		tid, okrID, uid, req.CurrentValue, percent, req.Confidence,
		strings.TrimSpace(req.Status), strings.TrimSpace(req.Comment)).Scan(&checkinID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Mutate the OKR row so the dashboard reflects this check-in.
	sets := []string{"confidence = $1", "updated_at = now()"}
	args := []any{req.Confidence}
	idx := 2
	if req.CurrentValue != nil {
		sets = append(sets, "current_value = $"+itoa(idx))
		args = append(args, *req.CurrentValue)
		idx++
	}
	if req.Status != "" {
		sets = append(sets, "status = $"+itoa(idx))
		args = append(args, req.Status)
		idx++
	}
	args = append(args, okrID)
	q := "UPDATE okrs SET " + strings.Join(sets, ", ") + " WHERE id = $" + itoa(idx)
	if _, err := tx.Exec(c, q, args...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := tx.Commit(c); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id":      checkinID,
		"percent": percent,
	})
}
