package handlers

import (
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/decapods/pgdp/backend/internal/auth"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/notifications"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Personnel — the HR "file on each staff member": NIN, blood group,
// emergency contact, next of kin, guarantor, payroll basics, and document
// uploads (CV, NIN slip, ID card, certificates).
//
// Two front doors, one handler:
//   • /me/personnel*            — the caller edits their own record.
//   • /members/:id/personnel*   — HR edits anyone's; gated by
//                                 workforce:write OR governance:write.
//
// targetUser() resolves which it is and enforces the gate, so every
// method below is a thin wrapper around the shared logic.
type Personnel struct {
	db     *pgxpool.Pool
	notify *notifications.Engine
}

func NewPersonnel(db *pgxpool.Pool) *Personnel { return &Personnel{db: db} }

// WithEngine attaches the notification engine so RemindAll can fan a
// "complete your profile" email + bell out to the whole workspace.
func (h *Personnel) WithEngine(e *notifications.Engine) *Personnel {
	h.notify = e
	return h
}

// RemindAll — HR broadcasts a "fill in your personnel profile" reminder
// to every active member, with a deadline N days out (default 5). Fires
// the personnel.profile_reminder event (immediate tier → bell + email,
// still subject to each user's category prefs). Gated to HR/governance
// in the router.
func (h *Personnel) RemindAll(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	if h.notify == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "notifications engine unavailable"})
		return
	}
	var req struct {
		DeadlineDays int `json:"deadline_days"`
	}
	_ = c.ShouldBindJSON(&req)
	days := req.DeadlineDays
	if days <= 0 || days > 60 {
		days = 5
	}
	deadline := time.Now().UTC().AddDate(0, 0, days).Format("Mon 2 Jan 2006")

	rows, err := h.db.Query(c, `
		SELECT id FROM users
		WHERE tenant_id=$1 AND deleted_at IS NULL AND status='active'`, tid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	recipients := []notifications.Recipient{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			id := id
			recipients = append(recipients, notifications.Recipient{UserID: &id})
		}
	}
	if len(recipients) == 0 {
		c.JSON(http.StatusOK, gin.H{"sent": 0})
		return
	}
	h.notify.Notify(c.Request.Context(), notifications.Event{
		Kind:       "personnel.profile_reminder",
		TenantID:   tid,
		Recipients: recipients,
		Payload: map[string]any{
			"Deadline": deadline,
		},
		// One reminder per tenant per day — re-clicking the button won't
		// spam people who already got it this morning.
		DedupeKey: "personnel.profile_reminder:" + tid.String() + ":" + time.Now().UTC().Format("2006-01-02"),
		Link:      "/my-work?tab=profile",
	})
	c.JSON(http.StatusOK, gin.H{"sent": len(recipients), "deadline": deadline})
}

// targetUser returns the user id the request operates on. For /me/* routes
// that's the caller. For /members/:id/* routes it's the path param, but
// only if the caller is HR-class (workforce:write / governance:write) or
// is editing themselves. Writes the error response + returns ok=false
// when the caller isn't allowed.
func (h *Personnel) targetUser(c *gin.Context) (uuid.UUID, bool) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	idParam := c.Param("id")
	if idParam == "" {
		return uid, true // /me/* — always self
	}
	target, err := uuid.Parse(idParam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return uuid.Nil, false
	}
	if target == uid {
		return target, true // editing your own record via the members route
	}
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	if auth.HasPermission(roles, "workforce:write") || auth.HasPermission(roles, "governance:write") {
		return target, true
	}
	c.JSON(http.StatusForbidden, gin.H{"error": "only HR can view or edit someone else's personnel record"})
	return uuid.Nil, false
}

// personnelFields — the editable structured columns. Centralised so Get +
// Put stay in sync and we never drift the column list.
var personnelFields = []string{
	"nin", "blood_group", "genotype", "date_of_birth", "gender",
	"marital_status", "home_address", "personal_email", "personal_phone",
	"emergency_name", "emergency_phone", "emergency_relationship",
	"nok_name", "nok_phone", "nok_relationship", "nok_address",
	"guarantor_name", "guarantor_phone", "guarantor_email",
	"guarantor_address", "guarantor_occupation", "guarantor_relationship",
	"bank_name", "bank_account_number", "bank_account_name", "notes",
}

// Get returns the structured record + the document list (metadata only —
// bytes are streamed separately by GetDocument).
func (h *Personnel) Get(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	target, ok := h.targetUser(c)
	if !ok {
		return
	}

	row := h.db.QueryRow(c, `
		SELECT nin, blood_group, genotype, date_of_birth, gender,
		       marital_status, home_address, personal_email, personal_phone,
		       emergency_name, emergency_phone, emergency_relationship,
		       nok_name, nok_phone, nok_relationship, nok_address,
		       guarantor_name, guarantor_phone, guarantor_email,
		       guarantor_address, guarantor_occupation, guarantor_relationship,
		       bank_name, bank_account_number, bank_account_name, notes,
		       updated_at
		  FROM user_personnel WHERE user_id=$1 AND tenant_id=$2`, target, tid)

	var (
		nin, bg, gt, gender, marital, addr, pEmail, pPhone           *string
		dob                                                          *time.Time
		emN, emP, emR                                                *string
		nokN, nokP, nokR, nokA                                       *string
		gN, gP, gE, gA, gO, gR                                        *string
		bankN, bankAcc, bankAccName, notes                           *string
		updatedAt                                                    *time.Time
	)
	err := row.Scan(&nin, &bg, &gt, &dob, &gender, &marital, &addr, &pEmail, &pPhone,
		&emN, &emP, &emR, &nokN, &nokP, &nokR, &nokA,
		&gN, &gP, &gE, &gA, &gO, &gR, &bankN, &bankAcc, &bankAccName, &notes, &updatedAt)
	rec := gin.H{}
	if err == nil {
		dobStr := ""
		if dob != nil {
			dobStr = dob.Format("2006-01-02")
		}
		rec = gin.H{
			"nin": s(nin), "blood_group": s(bg), "genotype": s(gt),
			"date_of_birth": dobStr, "gender": s(gender), "marital_status": s(marital),
			"home_address": s(addr), "personal_email": s(pEmail), "personal_phone": s(pPhone),
			"emergency_name": s(emN), "emergency_phone": s(emP), "emergency_relationship": s(emR),
			"nok_name": s(nokN), "nok_phone": s(nokP), "nok_relationship": s(nokR), "nok_address": s(nokA),
			"guarantor_name": s(gN), "guarantor_phone": s(gP), "guarantor_email": s(gE),
			"guarantor_address": s(gA), "guarantor_occupation": s(gO), "guarantor_relationship": s(gR),
			"bank_name": s(bankN), "bank_account_number": s(bankAcc), "bank_account_name": s(bankAccName),
			"notes": s(notes),
		}
		if updatedAt != nil {
			rec["updated_at"] = updatedAt
		}
	} else if err != pgx.ErrNoRows {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	docs := []gin.H{}
	if drows, derr := h.db.Query(c, `
		SELECT id, kind, name, mime, size_bytes, created_at
		  FROM user_documents WHERE user_id=$1 AND tenant_id=$2
		  ORDER BY created_at DESC`, target, tid); derr == nil {
		defer drows.Close()
		for drows.Next() {
			var (
				id              uuid.UUID
				kind, name      string
				mime            *string
				size            int64
				created         time.Time
			)
			if err := drows.Scan(&id, &kind, &name, &mime, &size, &created); err == nil {
				docs = append(docs, gin.H{
					"id": id, "kind": kind, "name": name, "mime": s(mime),
					"size_bytes": size, "created_at": created,
				})
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"record": rec, "documents": docs})
}

// Put upserts the structured record. Accepts a flat JSON object; only
// known columns are written (unknown keys ignored). Empty string clears
// a field; absent key leaves it untouched.
func (h *Personnel) Put(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	target, ok := h.targetUser(c)
	if !ok {
		return
	}
	var body map[string]any
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Ensure the row exists first so the dynamic UPDATE always hits.
	if _, err := h.db.Exec(c, `
		INSERT INTO user_personnel (user_id, tenant_id)
		VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING`, target, tid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	allowed := map[string]bool{}
	for _, f := range personnelFields {
		allowed[f] = true
	}
	sets := []string{"updated_at=now()", "updated_by=$1"}
	args := []any{uid}
	for k, v := range body {
		if !allowed[k] {
			continue
		}
		// date_of_birth: empty string → NULL, else pass the YYYY-MM-DD
		// string and let Postgres cast.
		args = append(args, normalizePersonnelVal(k, v))
		sets = append(sets, k+"=$"+itoaP(len(args)))
	}
	args = append(args, target, tid)
	q := "UPDATE user_personnel SET " + strings.Join(sets, ", ") +
		" WHERE user_id=$" + itoaP(len(args)-1) + " AND tenant_id=$" + itoaP(len(args))
	if _, err := h.db.Exec(c, q, args...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func normalizePersonnelVal(key string, v any) any {
	str, isStr := v.(string)
	if key == "date_of_birth" {
		if !isStr || strings.TrimSpace(str) == "" {
			return nil
		}
		return str
	}
	if isStr && strings.TrimSpace(str) == "" {
		return nil
	}
	return v
}

// UploadDocument — multipart CV / NIN slip / etc. Mirrors project_files:
// 25MB cap, bytes inline as bytea.
func (h *Personnel) UploadDocument(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	target, ok := h.targetUser(c)
	if !ok {
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxFileBytes+1024*1024)
	if err := c.Request.ParseMultipartForm(maxMemMultipart); err != nil {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "upload too large (max 25MB)"})
		return
	}
	fh, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing file"})
		return
	}
	if fh.Size > maxFileBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "file exceeds 25MB cap"})
		return
	}
	kind := strings.TrimSpace(c.PostForm("kind"))
	switch kind {
	case "cv", "nin_slip", "id_card", "certificate", "contract", "other":
	default:
		kind = "other"
	}
	name := strings.TrimSpace(c.PostForm("name"))
	if name == "" {
		name = fh.Filename
	}
	f, err := openFormFile(fh)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer f.Close()
	content, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if int64(len(content)) > maxFileBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "file exceeds 25MB cap"})
		return
	}
	mime := fh.Header.Get("Content-Type")
	if mime == "" {
		mime = guessMimeFromName(fh.Filename)
	}
	var id uuid.UUID
	if err := h.db.QueryRow(c, `
		INSERT INTO user_documents (tenant_id, user_id, kind, name, mime, size_bytes, content, uploaded_by)
		VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8) RETURNING id`,
		tid, target, kind, name, mime, len(content), content, uid).Scan(&id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

// GetDocument streams the bytea back as an attachment.
func (h *Personnel) GetDocument(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	target, ok := h.targetUser(c)
	if !ok {
		return
	}
	docID, err := uuid.Parse(c.Param("docID"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	var (
		name    string
		mime    *string
		content []byte
	)
	if err := h.db.QueryRow(c, `
		SELECT name, mime, content FROM user_documents
		 WHERE id=$1 AND user_id=$2 AND tenant_id=$3`, docID, target, tid).
		Scan(&name, &mime, &content); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "document not found"})
		return
	}
	ct := "application/octet-stream"
	if mime != nil && *mime != "" {
		ct = *mime
	}
	c.Header("Content-Disposition", `attachment; filename="`+escapeFilename(name)+`"`)
	c.Data(http.StatusOK, ct, content)
}

// DeleteDocument removes one document. Same target/gate rule.
func (h *Personnel) DeleteDocument(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	target, ok := h.targetUser(c)
	if !ok {
		return
	}
	docID, err := uuid.Parse(c.Param("docID"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	if _, err := h.db.Exec(c, `
		DELETE FROM user_documents WHERE id=$1 AND user_id=$2 AND tenant_id=$3`,
		docID, target, tid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// s — nil-safe *string → string.
func s(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// itoaP — local int→string (avoids importing strconv just for this file).
func itoaP(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
