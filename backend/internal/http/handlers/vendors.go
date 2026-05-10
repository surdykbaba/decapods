package handlers

import (
	"crypto/rand"
	"encoding/base64"
	"strconv"
	"strings"
	"time"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Vendors struct {
	db *pgxpool.Pool
}

func NewVendors(db *pgxpool.Pool) *Vendors { return &Vendors{db: db} }

// MandatoryDocKinds is the document set every vendor must have on file before
// they can be assigned to projects. Mirrored on the frontend checklist.
var MandatoryDocKinds = []string{
	"profile",            // company profile
	"tax_cert",           // tax / TIN compliance
	"service_agreement",  // master services agreement
	"sla",                // signed SLA
}

// List returns all non-deleted vendors for the tenant, with computed fields the
// directory UI needs (doc counts, kinds-on-file, assigned project count placeholder).
// Optional filters: status, competency, kind, service_category, risk_level.
func (h *Vendors) List(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	args := []any{tid}
	q := `SELECT v.id, v.name, COALESCE(v.legal_name,''), v.kind,
		COALESCE(v.contact_name,''), COALESCE(v.contact_email,''), COALESCE(v.contact_phone,''),
		COALESCE(v.website,''), COALESCE(v.country,''), v.competencies, v.status,
		v.sla_signed_at, v.sla_expires_at, COALESCE(v.notes,''), v.created_at,
		COALESCE(v.service_category,''), COALESCE(v.risk_level,'low'), v.last_activity_at,
		(SELECT count(*) FROM vendor_documents vd WHERE vd.vendor_id=v.id) AS doc_count,
		(SELECT array_agg(DISTINCT vd.kind) FROM vendor_documents vd WHERE vd.vendor_id=v.id) AS doc_kinds
		FROM vendors v
		WHERE v.tenant_id=$1 AND v.deleted_at IS NULL`
	addFilter := func(col, val string) {
		args = append(args, val)
		q += " AND v." + col + "=$" + strconv.Itoa(len(args))
	}
	if s := c.Query("status");           s != "" { addFilter("status", s) }
	if k := c.Query("kind");              k != "" { addFilter("kind", k) }
	if sc := c.Query("service_category"); sc != "" { addFilter("service_category", sc) }
	if r := c.Query("risk_level");        r != "" { addFilter("risk_level", r) }
	if cmp := c.Query("competency"); cmp != "" {
		args = append(args, cmp)
		q += " AND $" + strconv.Itoa(len(args)) + " = ANY(v.competencies)"
	}
	q += " ORDER BY v.created_at DESC"
	rows, err := h.db.Query(c, q, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id, kind, status, name, legal, contactN, contactE, contactP, web, country, notes,
			serviceCat, risk string
			comps, docKinds        []string
			slaSigned, slaExpires  *time.Time
			lastActivity           *time.Time
			created                time.Time
			docCount               int
		)
		if err := rows.Scan(&id, &name, &legal, &kind, &contactN, &contactE, &contactP, &web, &country,
			&comps, &status, &slaSigned, &slaExpires, &notes, &created,
			&serviceCat, &risk, &lastActivity, &docCount, &docKinds); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		// Mandatory doc gate: vendor cannot be assigned to projects until all are on file.
		missing := []string{}
		have := map[string]bool{}
		for _, k := range docKinds {
			have[k] = true
		}
		for _, k := range MandatoryDocKinds {
			if !have[k] {
				missing = append(missing, k)
			}
		}
		out = append(out, gin.H{
			"id": id, "name": name, "legal_name": legal, "kind": kind,
			"contact_name": contactN, "contact_email": contactE, "contact_phone": contactP,
			"website": web, "country": country, "competencies": comps, "status": status,
			"sla_signed_at": slaSigned, "sla_expires_at": slaExpires, "notes": notes,
			"created_at":           created,
			"service_category":     serviceCat,
			"risk_level":           risk,
			"last_activity_at":     lastActivity,
			"document_count":       docCount,
			"document_kinds":       docKinds,
			"mandatory_missing":    missing,
			"can_be_assigned":      len(missing) == 0,
			// Placeholders — wired up properly when Sections 4/5/8 land.
			"assigned_projects_count": 0,
			"open_deliverables_count": 0,
			"performance_score":       nil,
			"outstanding_balance":     0,
		})
	}
	c.JSON(200, gin.H{"items": out, "mandatory_kinds": MandatoryDocKinds})
}

func (h *Vendors) Create(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Name         string   `json:"name"`
		LegalName    string   `json:"legal_name"`
		Kind         string   `json:"kind"`
		ContactName  string   `json:"contact_name"`
		ContactEmail string   `json:"contact_email"`
		ContactPhone string   `json:"contact_phone"`
		Website      string   `json:"website"`
		Country      string   `json:"country"`
		Competencies    []string `json:"competencies"`
		Notes           string   `json:"notes"`
		ServiceCategory string   `json:"service_category"`
		RiskLevel       string   `json:"risk_level"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		c.JSON(400, gin.H{"error": "name is required"})
		return
	}
	if req.Kind == "" {
		req.Kind = "consultant"
	}
	if req.Competencies == nil {
		req.Competencies = []string{}
	}
	if req.RiskLevel == "" { req.RiskLevel = "low" }
	var id uuid.UUID
	err := h.db.QueryRow(c, `
		INSERT INTO vendors (tenant_id, name, legal_name, kind, contact_name, contact_email, contact_phone,
			website, country, competencies, notes, service_category, risk_level, last_activity_at, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),$14) RETURNING id`,
		tid, req.Name, req.LegalName, req.Kind, req.ContactName, req.ContactEmail, req.ContactPhone,
		req.Website, req.Country, req.Competencies, req.Notes, req.ServiceCategory, req.RiskLevel, uid,
	).Scan(&id)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

func (h *Vendors) Get(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	row := h.db.QueryRow(c, `
		SELECT id, name, COALESCE(legal_name,''), kind,
		COALESCE(contact_name,''), COALESCE(contact_email,''), COALESCE(contact_phone,''),
		COALESCE(website,''), COALESCE(country,''), competencies, status,
		sla_signed_at, sla_expires_at, COALESCE(notes,''), created_at,
		COALESCE(service_category,''), COALESCE(risk_level,'low'), last_activity_at
		FROM vendors WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`, id, tid)
	var (
		vid, kind, status, name, legal, cn, ce, cp, web, country, notes, serviceCat, risk string
		comps                                                            []string
		slaS, slaE, lastAct                                              *time.Time
		created                                                          time.Time
	)
	if err := row.Scan(&vid, &name, &legal, &kind, &cn, &ce, &cp, &web, &country, &comps, &status,
		&slaS, &slaE, &notes, &created, &serviceCat, &risk, &lastAct); err != nil {
		c.JSON(404, gin.H{"error": "vendor not found"})
		return
	}
	// Fetch documents
	docs := []gin.H{}
	drows, err := h.db.Query(c, `
		SELECT id, kind, name, object_key, uploaded_at FROM vendor_documents
		WHERE vendor_id=$1 ORDER BY uploaded_at DESC`, id)
	if err == nil {
		defer drows.Close()
		for drows.Next() {
			var did, dk, dn, dk2 string
			var ts time.Time
			if err := drows.Scan(&did, &dk, &dn, &dk2, &ts); err == nil {
				docs = append(docs, gin.H{"id": did, "kind": dk, "name": dn, "object_key": dk2, "uploaded_at": ts})
			}
		}
	}
	// Mandatory doc gate
	have := map[string]bool{}
	for _, d := range docs {
		if k, ok := d["kind"].(string); ok { have[k] = true }
	}
	missing := []string{}
	for _, k := range MandatoryDocKinds {
		if !have[k] { missing = append(missing, k) }
	}
	c.JSON(200, gin.H{
		"id": vid, "name": name, "legal_name": legal, "kind": kind,
		"contact_name": cn, "contact_email": ce, "contact_phone": cp,
		"website": web, "country": country, "competencies": comps, "status": status,
		"sla_signed_at": slaS, "sla_expires_at": slaE, "notes": notes,
		"created_at": created, "documents": docs,
		"service_category":  serviceCat,
		"risk_level":        risk,
		"last_activity_at":  lastAct,
		"mandatory_missing": missing,
		"can_be_assigned":   len(missing) == 0,
		"mandatory_kinds":   MandatoryDocKinds,
		// Stubs — populated when Sections 4-9 land.
		"assigned_projects":   []any{},
		"open_deliverables":   []any{},
		"performance_score":   nil,
		"outstanding_balance": 0,
	})
}

func (h *Vendors) Update(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct {
		Name         *string   `json:"name"`
		LegalName    *string   `json:"legal_name"`
		Kind         *string   `json:"kind"`
		ContactName  *string   `json:"contact_name"`
		ContactEmail *string   `json:"contact_email"`
		ContactPhone *string   `json:"contact_phone"`
		Website      *string   `json:"website"`
		Country      *string   `json:"country"`
		Competencies *[]string `json:"competencies"`
		Status          *string `json:"status"`
		Notes           *string `json:"notes"`
		ServiceCategory *string `json:"service_category"`
		RiskLevel       *string `json:"risk_level"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	sets := []string{"updated_at=now()"}
	args := []any{}
	add := func(col string, v any) { args = append(args, v); sets = append(sets, col+"=$"+strconv.Itoa(len(args))) }
	if req.Name != nil         { add("name", strings.TrimSpace(*req.Name)) }
	if req.LegalName != nil    { add("legal_name", *req.LegalName) }
	if req.Kind != nil         { add("kind", *req.Kind) }
	if req.ContactName != nil  { add("contact_name", *req.ContactName) }
	if req.ContactEmail != nil { add("contact_email", *req.ContactEmail) }
	if req.ContactPhone != nil { add("contact_phone", *req.ContactPhone) }
	if req.Website != nil      { add("website", *req.Website) }
	if req.Country != nil      { add("country", *req.Country) }
	if req.Competencies != nil { add("competencies", *req.Competencies) }
	if req.Status != nil {
		valid := map[string]bool{"draft": true, "onboarded": true, "sla_signed": true, "suspended": true}
		if !valid[*req.Status] {
			c.JSON(400, gin.H{"error": "invalid status"})
			return
		}
		add("status", *req.Status)
	}
	if req.Notes != nil { add("notes", *req.Notes) }
	if req.ServiceCategory != nil { add("service_category", *req.ServiceCategory) }
	if req.RiskLevel != nil {
		validR := map[string]bool{"low": true, "medium": true, "high": true, "critical": true}
		if !validR[*req.RiskLevel] {
			c.JSON(400, gin.H{"error": "invalid risk_level"})
			return
		}
		add("risk_level", *req.RiskLevel)
	}
	// Bump last_activity_at on any update so the directory shows "fresh" vendors first.
	sets = append(sets, "last_activity_at=now()")
	if len(args) == 0 {
		c.JSON(400, gin.H{"error": "no changes"})
		return
	}
	args = append(args, id, tid)
	q := "UPDATE vendors SET " + strings.Join(sets, ", ") +
		" WHERE id=$" + strconv.Itoa(len(args)-1) + " AND tenant_id=$" + strconv.Itoa(len(args)) + " AND deleted_at IS NULL"
	if _, err := h.db.Exec(c, q, args...); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (h *Vendors) Delete(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	if _, err := h.db.Exec(c,
		`UPDATE vendors SET deleted_at=now() WHERE id=$1 AND tenant_id=$2`, id, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// SignSLA marks the SLA as signed and bumps the vendor to sla_signed status.
// Body: { effective_date?: ISO, expires_date?: ISO, document_url?: string, document_name?: string }
// If a document_url is provided, an SLA document row is also created.
func (h *Vendors) SignSLA(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct {
		EffectiveDate *time.Time `json:"effective_date"`
		ExpiresDate   *time.Time `json:"expires_date"`
		DocumentURL   string     `json:"document_url"`
		DocumentName  string     `json:"document_name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	signed := time.Now()
	if req.EffectiveDate != nil { signed = *req.EffectiveDate }

	tx, err := h.db.Begin(c)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	defer tx.Rollback(c)

	if _, err := tx.Exec(c, `
		UPDATE vendors SET status='sla_signed', sla_signed_at=$1, sla_expires_at=$2, updated_at=now()
		WHERE id=$3 AND tenant_id=$4 AND deleted_at IS NULL`,
		signed, req.ExpiresDate, id, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if req.DocumentURL != "" {
		name := req.DocumentName
		if name == "" { name = "SLA agreement" }
		if _, err := tx.Exec(c, `
			INSERT INTO vendor_documents (vendor_id, kind, name, object_key, uploaded_by)
			VALUES ($1,'sla',$2,$3,$4)`, id, name, req.DocumentURL, uid); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
	}
	if err := tx.Commit(c); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true, "status": "sla_signed", "sla_signed_at": signed})
}

func (h *Vendors) AddDocument(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct {
		Kind       string `json:"kind"`
		Name       string `json:"name"`
		ObjectKey  string `json:"object_key"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if req.Kind == "" || req.Name == "" || req.ObjectKey == "" {
		c.JSON(400, gin.H{"error": "kind, name and object_key are required"})
		return
	}
	// Confirm the vendor belongs to this tenant before inserting.
	var owner uuid.UUID
	if err := h.db.QueryRow(c, `SELECT tenant_id FROM vendors WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&owner); err != nil || owner != tid {
		c.JSON(404, gin.H{"error": "vendor not found"})
		return
	}
	var docID uuid.UUID
	if err := h.db.QueryRow(c, `
		INSERT INTO vendor_documents (vendor_id, kind, name, object_key, uploaded_by)
		VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		id, req.Kind, req.Name, req.ObjectKey, uid).Scan(&docID); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	// If profile-grade docs are now present, auto-promote draft → onboarded.
	if req.Kind == "profile" || req.Kind == "tax_cert" || req.Kind == "insurance" {
		_, _ = h.db.Exec(c, `
			UPDATE vendors SET status='onboarded', updated_at=now()
			WHERE id=$1 AND status='draft'`, id)
	}
	c.JSON(201, gin.H{"id": docID})
}

func (h *Vendors) DeleteDocument(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	docID, err := uuid.Parse(c.Param("docId"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	// Tenant-safe: join through vendors to confirm ownership.
	if _, err := h.db.Exec(c, `
		DELETE FROM vendor_documents
		WHERE id=$1 AND vendor_id IN (SELECT id FROM vendors WHERE tenant_id=$2)`,
		docID, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}


/* --------------- Vendor invitations (self-onboarding via link) ---------------
 *
 * Authenticated user creates an invite for an existing vendor row. The vendor
 * receives a public link `/vendor-invite/<token>` (frontend route) which calls
 * the unauthenticated `GET /api/v1/vendor-invite/:token` to fetch context and
 * `POST /api/v1/vendor-invite/:token` to submit their details.
 *
 * The submitted payload PATCHes the vendor row directly (contact / website /
 * competencies / notes) and inserts any document URLs the vendor provided.
 * Status flips draft → onboarded once the mandatory doc set lands; SLA still
 * has to be marked signed by an internal user.
 */

const inviteTTL = 14 * 24 * time.Hour

// CreateInvite mints a token for a vendor and returns the public URL.
// POST /vendors/:id/invite  body: { email, message? }
func (h *Vendors) CreateInvite(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct {
		Email   string `json:"email"`
		Message string `json:"message"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	req.Email = strings.TrimSpace(req.Email)
	if req.Email == "" {
		c.JSON(400, gin.H{"error": "email is required"})
		return
	}

	// Confirm vendor belongs to this tenant.
	var vname string
	if err := h.db.QueryRow(c,
		`SELECT name FROM vendors WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`,
		id, tid).Scan(&vname); err != nil {
		c.JSON(404, gin.H{"error": "vendor not found"})
		return
	}

	// 32-byte URL-safe token. Long enough that a brute force is irrelevant.
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	token := base64.RawURLEncoding.EncodeToString(buf)

	// Optional: revoke any earlier pending invites for this vendor — only one live link at a time.
	_, _ = h.db.Exec(c,
		`UPDATE vendor_invitations SET revoked_at=now()
		 WHERE vendor_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL`, id)

	expires := time.Now().Add(inviteTTL)
	if _, err := h.db.Exec(c, `
		INSERT INTO vendor_invitations (tenant_id, vendor_id, token, email, message, expires_at, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		tid, id, token, req.Email, req.Message, expires, uid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(201, gin.H{
		"token":      token,
		"expires_at": expires,
		"vendor":     vname,
		"email":      req.Email,
	})
}

// ListInvites returns the live + historical invitations for a vendor.
// GET /vendors/:id/invites
func (h *Vendors) ListInvites(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	rows, err := h.db.Query(c, `
		SELECT id, token, email, COALESCE(message,''), created_at, expires_at, accepted_at, revoked_at
		FROM vendor_invitations
		WHERE vendor_id=$1 AND tenant_id=$2
		ORDER BY created_at DESC LIMIT 20`, id, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			invID                          uuid.UUID
			token, email, msg              string
			created, expires               time.Time
			accepted, revoked              *time.Time
		)
		if err := rows.Scan(&invID, &token, &email, &msg, &created, &expires, &accepted, &revoked); err == nil {
			status := "pending"
			if revoked != nil {
				status = "revoked"
			} else if accepted != nil {
				status = "accepted"
			} else if time.Now().After(expires) {
				status = "expired"
			}
			out = append(out, gin.H{
				"id": invID, "token": token, "email": email, "message": msg,
				"created_at": created, "expires_at": expires,
				"accepted_at": accepted, "revoked_at": revoked, "status": status,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

// RevokeInvite cancels a pending invite so its link can no longer be used.
func (h *Vendors) RevokeInvite(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	invID, err := uuid.Parse(c.Param("inviteId"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	if _, err := h.db.Exec(c,
		`UPDATE vendor_invitations SET revoked_at=now()
		 WHERE id=$1 AND tenant_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL`, invID, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// PublicGetInvite returns the public-safe details of an invitation given its token.
// GET /vendor-invite/:token   (no auth)
func (h *Vendors) PublicGetInvite(c *gin.Context) {
	token := c.Param("token")
	if token == "" {
		c.JSON(400, gin.H{"error": "missing token"})
		return
	}
	var (
		vid                                                            uuid.UUID
		email, msg, vname, vkind, vCountry, vCategory, status          string
		expires                                                        time.Time
		accepted, revoked                                              *time.Time
	)
	err := h.db.QueryRow(c, `
		SELECT i.vendor_id, i.email, COALESCE(i.message,''), i.expires_at, i.accepted_at, i.revoked_at,
		       v.name, v.kind, COALESCE(v.country,''), COALESCE(v.service_category,''), v.status
		FROM vendor_invitations i
		JOIN vendors v ON v.id = i.vendor_id
		WHERE i.token=$1`, token).Scan(
		&vid, &email, &msg, &expires, &accepted, &revoked,
		&vname, &vkind, &vCountry, &vCategory, &status,
	)
	if err != nil {
		c.JSON(404, gin.H{"error": "invitation not found"})
		return
	}
	switch {
	case revoked != nil:
		c.JSON(410, gin.H{"error": "This invitation has been revoked.", "code": "revoked"})
		return
	case accepted != nil:
		c.JSON(410, gin.H{"error": "This invitation has already been completed.", "code": "accepted"})
		return
	case time.Now().After(expires):
		c.JSON(410, gin.H{"error": "This invitation has expired.", "code": "expired"})
		return
	}

	c.JSON(200, gin.H{
		"vendor_id":        vid,
		"vendor_name":      vname,
		"vendor_kind":      vkind,
		"vendor_country":   vCountry,
		"service_category": vCategory,
		"status":           status,
		"invited_email":    email,
		"message":          msg,
		"expires_at":       expires,
		// What we want them to fill / attach.
		"requested_fields": []string{
			"legal_name", "contact_name", "contact_email", "contact_phone",
			"website", "country", "competencies", "notes",
		},
		"required_documents": MandatoryDocKinds,
	})
}

// PublicAcceptInvite — vendor submits their details. Patches the vendor row,
// inserts any documents they provided, marks the invitation accepted.
// POST /vendor-invite/:token   (no auth)
func (h *Vendors) PublicAcceptInvite(c *gin.Context) {
	token := c.Param("token")
	if token == "" {
		c.JSON(400, gin.H{"error": "missing token"})
		return
	}
	var req struct {
		LegalName    string   `json:"legal_name"`
		ContactName  string   `json:"contact_name"`
		ContactEmail string   `json:"contact_email"`
		ContactPhone string   `json:"contact_phone"`
		Website      string   `json:"website"`
		Country      string   `json:"country"`
		Competencies []string `json:"competencies"`
		Notes        string   `json:"notes"`
		Documents    []struct {
			Kind      string `json:"kind"`
			Name      string `json:"name"`
			ObjectKey string `json:"object_key"`
		} `json:"documents"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	// Look up + lock the invitation.
	var (
		vid                uuid.UUID
		expires            time.Time
		accepted, revoked  *time.Time
	)
	if err := h.db.QueryRow(c, `
		SELECT vendor_id, expires_at, accepted_at, revoked_at
		FROM vendor_invitations WHERE token=$1`, token).Scan(&vid, &expires, &accepted, &revoked); err != nil {
		c.JSON(404, gin.H{"error": "invitation not found"})
		return
	}
	switch {
	case revoked != nil:
		c.JSON(410, gin.H{"error": "Invitation revoked.", "code": "revoked"})
		return
	case accepted != nil:
		c.JSON(410, gin.H{"error": "Invitation already used.", "code": "accepted"})
		return
	case time.Now().After(expires):
		c.JSON(410, gin.H{"error": "Invitation expired.", "code": "expired"})
		return
	}

	tx, err := h.db.Begin(c)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(c)

	// Build a partial update for the vendor row. Only writes fields the vendor
	// actually filled — preserves what the inviter set up front.
	sets := []string{"updated_at=now()", "last_activity_at=now()"}
	args := []any{}
	add := func(col string, v any) { args = append(args, v); sets = append(sets, col+"=$"+strconv.Itoa(len(args))) }
	if s := strings.TrimSpace(req.LegalName);    s != "" { add("legal_name", s) }
	if s := strings.TrimSpace(req.ContactName);  s != "" { add("contact_name", s) }
	if s := strings.TrimSpace(req.ContactEmail); s != "" { add("contact_email", s) }
	if s := strings.TrimSpace(req.ContactPhone); s != "" { add("contact_phone", s) }
	if s := strings.TrimSpace(req.Website);      s != "" { add("website", s) }
	if s := strings.TrimSpace(req.Country);      s != "" { add("country", s) }
	if s := strings.TrimSpace(req.Notes);        s != "" { add("notes", s) }
	if req.Competencies != nil { add("competencies", req.Competencies) }
	args = append(args, vid)
	if _, err := tx.Exec(c,
		"UPDATE vendors SET "+strings.Join(sets, ", ")+" WHERE id=$"+strconv.Itoa(len(args)),
		args...); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Insert any documents they provided. Anonymously — uploaded_by is NULL.
	for _, d := range req.Documents {
		if d.Kind == "" || d.Name == "" || d.ObjectKey == "" {
			continue
		}
		if _, err := tx.Exec(c, `
			INSERT INTO vendor_documents (vendor_id, kind, name, object_key)
			VALUES ($1,$2,$3,$4)`, vid, d.Kind, d.Name, d.ObjectKey); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
	}

	// If the mandatory set is now complete, promote draft → onboarded.
	var docKinds []string
	if err := tx.QueryRow(c,
		`SELECT array_agg(DISTINCT kind) FROM vendor_documents WHERE vendor_id=$1`, vid).Scan(&docKinds); err == nil {
		have := map[string]bool{}
		for _, k := range docKinds { have[k] = true }
		complete := true
		for _, k := range MandatoryDocKinds {
			if !have[k] { complete = false; break }
		}
		if complete {
			_, _ = tx.Exec(c,
				`UPDATE vendors SET status='onboarded', updated_at=now()
				 WHERE id=$1 AND status='draft'`, vid)
		}
	}

	if _, err := tx.Exec(c,
		`UPDATE vendor_invitations SET accepted_at=now() WHERE token=$1`, token); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if err := tx.Commit(c); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}
