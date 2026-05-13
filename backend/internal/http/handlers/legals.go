package handlers

// Legals — workspace document warehouse for statutory + compliance
// records. See migration 000053_legal_documents for the table shape.
//
// Permission model:
//   • List / Get download — governance:read (everyone with portal access
//     who's also been granted the read scope; HR + leadership by default).
//   • Create / Update / Delete — governance:write (CEO / COO / HR /
//     super_admin). Wired in router.go.

import (
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Legals struct{ db *pgxpool.Pool }

func NewLegals(db *pgxpool.Pool) *Legals { return &Legals{db: db} }

// validLegalCategories is the canonical category vocabulary. The frontend
// renders one filter chip per entry; adding a new category is a single
// line here. Other / Misc is the fallback so historical docs always
// classify.
var validLegalCategories = map[string]string{
	"nda":               "NDA",
	"employee_contract": "Employee contract",
	"client_contract":   "Client contract",
	"vendor_msa":        "Vendor MSA",
	"sow":               "Statement of work",
	"ip_assignment":     "IP assignment",
	"policy":            "Policy",
	"regulatory":        "Regulatory filing",
	"insurance":         "Insurance",
	"other":             "Other",
}

// validLegalStatus mirrors the column's allowed lifecycle states. We
// don't enforce at the DB level (text + default) so the API gates it
// here. UI uses the same enum.
var validLegalStatus = map[string]bool{
	"active":     true,
	"draft":      true,
	"expired":    true,
	"terminated": true,
}

// List returns the tenant's legal documents with optional filters
// (category, status, project_id, user_id, vendor_id, search q, expiring
// within N days). Everything paginated to 200; the smart filter chips
// in the UI mean the typical fetch is much smaller.
func (h *Legals) List(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	args := []any{tid}
	q := `
		SELECT d.id, d.category, d.title, COALESCE(d.party,''), COALESCE(d.reference_no,''),
		       d.project_id, p.name AS project_name,
		       d.user_id, u.full_name AS user_name, u.email::text AS user_email,
		       d.vendor_id, v.name AS vendor_name,
		       d.status, d.effective_date, d.expires_at, d.signed_at,
		       d.signed_by, signer.full_name AS signed_by_name,
		       COALESCE(d.filename,''), COALESCE(d.content_type,''),
		       d.size_bytes, (d.content IS NOT NULL) AS has_content,
		       COALESCE(d.external_url,''),
		       COALESCE(d.notes,''), d.tags, d.version,
		       d.uploaded_by, uploader.full_name AS uploaded_by_name,
		       d.created_at, d.updated_at
		FROM legal_documents d
		LEFT JOIN projects p     ON p.id = d.project_id
		LEFT JOIN users    u     ON u.id = d.user_id
		LEFT JOIN vendors  v     ON v.id = d.vendor_id
		LEFT JOIN users    signer   ON signer.id  = d.signed_by
		LEFT JOIN users    uploader ON uploader.id = d.uploaded_by
		WHERE d.tenant_id = $1`

	if cat := c.Query("category"); cat != "" && validLegalCategories[cat] != "" {
		args = append(args, cat)
		q += " AND d.category = $" + strconv.Itoa(len(args))
	}
	if status := c.Query("status"); status != "" && validLegalStatus[status] {
		args = append(args, status)
		q += " AND d.status = $" + strconv.Itoa(len(args))
	}
	if pid := c.Query("project_id"); pid != "" {
		if id, err := uuid.Parse(pid); err == nil {
			args = append(args, id)
			q += " AND d.project_id = $" + strconv.Itoa(len(args))
		}
	}
	if uid := c.Query("user_id"); uid != "" {
		if id, err := uuid.Parse(uid); err == nil {
			args = append(args, id)
			q += " AND d.user_id = $" + strconv.Itoa(len(args))
		}
	}
	if vid := c.Query("vendor_id"); vid != "" {
		if id, err := uuid.Parse(vid); err == nil {
			args = append(args, id)
			q += " AND d.vendor_id = $" + strconv.Itoa(len(args))
		}
	}
	if needle := c.Query("q"); needle != "" {
		args = append(args, "%"+needle+"%")
		idx := strconv.Itoa(len(args))
		q += " AND (d.title ILIKE $" + idx + " OR d.party ILIKE $" + idx + " OR d.reference_no ILIKE $" + idx + ")"
	}
	if days, _ := strconv.Atoi(c.Query("expiring_in_days")); days > 0 {
		args = append(args, days)
		idx := strconv.Itoa(len(args))
		q += " AND d.expires_at IS NOT NULL AND d.expires_at >= CURRENT_DATE AND d.expires_at <= CURRENT_DATE + ($" + idx + " || ' days')::interval"
	}
	q += " ORDER BY d.created_at DESC LIMIT 500"

	rows, err := h.db.Query(c, q, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id                                       uuid.UUID
			category, title, party, refNo            string
			projectID, userID, vendorID              *uuid.UUID
			projectName, userName, userEmail         *string
			vendorName                               *string
			status                                   string
			effDate, expDate                         *time.Time
			signedAt                                 *time.Time
			signedBy                                 *uuid.UUID
			signedByName                             *string
			filename, contentType                    string
			sizeBytes                                int64
			hasContent                               bool
			externalURL, notes                       string
			tags                                     []string
			version                                  int
			uploadedBy                               *uuid.UUID
			uploadedByName                           *string
			createdAt, updatedAt                     time.Time
		)
		if err := rows.Scan(&id, &category, &title, &party, &refNo,
			&projectID, &projectName,
			&userID, &userName, &userEmail,
			&vendorID, &vendorName,
			&status, &effDate, &expDate, &signedAt,
			&signedBy, &signedByName,
			&filename, &contentType, &sizeBytes, &hasContent, &externalURL,
			&notes, &tags, &version,
			&uploadedBy, &uploadedByName,
			&createdAt, &updatedAt); err == nil {
			row := gin.H{
				"id":             id,
				"category":       category,
				"category_label": validLegalCategories[category],
				"title":          title,
				"party":          party,
				"reference_no":   refNo,
				"status":         status,
				"effective_date": dateOrNil(effDate),
				"expires_at":     dateOrNil(expDate),
				"signed_at":      signedAt,
				"filename":       filename,
				"content_type":   contentType,
				"size_bytes":     sizeBytes,
				"has_content":    hasContent,
				"external_url":   externalURL,
				"notes":          notes,
				"tags":           tags,
				"version":        version,
				"created_at":     createdAt,
				"updated_at":     updatedAt,
			}
			if projectID != nil {
				row["project"] = gin.H{"id": *projectID, "name": derefStrL(projectName)}
			}
			if userID != nil {
				row["user"] = gin.H{"id": *userID, "name": derefStrL(userName), "email": derefStrL(userEmail)}
			}
			if vendorID != nil {
				row["vendor"] = gin.H{"id": *vendorID, "name": derefStrL(vendorName)}
			}
			if signedBy != nil {
				row["signed_by"] = gin.H{"id": *signedBy, "name": derefStrL(signedByName)}
			}
			if uploadedBy != nil {
				row["uploaded_by"] = gin.H{"id": *uploadedBy, "name": derefStrL(uploadedByName)}
			}
			out = append(out, row)
		}
	}

	// Stat block — counts + expiry warnings — computed in one round trip
	// so the dashboard doesn't pay for two requests.
	stats := gin.H{}
	type statRow struct {
		Total, Active, Expired, ExpiringSoon, Unsigned int64
	}
	var s statRow
	_ = h.db.QueryRow(c, `
		SELECT
			COUNT(*) AS total,
			COUNT(*) FILTER (WHERE status = 'active') AS active,
			COUNT(*) FILTER (WHERE status = 'expired' OR (expires_at IS NOT NULL AND expires_at < CURRENT_DATE)) AS expired,
			COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at >= CURRENT_DATE AND expires_at <= CURRENT_DATE + INTERVAL '30 days') AS expiring_soon,
			COUNT(*) FILTER (WHERE signed_at IS NULL AND status <> 'draft') AS unsigned
		FROM legal_documents WHERE tenant_id = $1`, tid).Scan(
		&s.Total, &s.Active, &s.Expired, &s.ExpiringSoon, &s.Unsigned)
	stats["total"] = s.Total
	stats["active"] = s.Active
	stats["expired"] = s.Expired
	stats["expiring_soon"] = s.ExpiringSoon
	stats["unsigned"] = s.Unsigned

	// Category breakdown — { category_key: count } for the smart chips.
	catCounts := map[string]int64{}
	crows, _ := h.db.Query(c, `
		SELECT category, COUNT(*) FROM legal_documents WHERE tenant_id=$1 GROUP BY category`, tid)
	if crows != nil {
		defer crows.Close()
		for crows.Next() {
			var k string
			var n int64
			if err := crows.Scan(&k, &n); err == nil {
				catCounts[k] = n
			}
		}
	}

	c.JSON(200, gin.H{
		"items":             out,
		"stats":             stats,
		"category_counts":   catCounts,
		"categories":        validLegalCategories,
	})
}

// dateOrNil — emit a yyyy-mm-dd string for date columns, or null. Plain
// time.Time would serialise as a full timestamptz which the SPA then has
// to slice.
func dateOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.Format("2006-01-02")
}

// Create accepts multipart/form-data. The file is optional — for
// link-only entries (SharePoint, Box, external counsel folder) the user
// drops in external_url instead. JSON body is supported too for
// programmatic clients that skip the upload.
func (h *Legals) Create(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)

	var (
		category, title, party, refNo string
		status                        = "active"
		notes, externalURL            string
		projectID, userID, vendorID   *uuid.UUID
		effDate, expDate              *time.Time
		signedAt                      *time.Time
		tags                          []string
		filename, contentType         string
		content                       []byte
	)

	ct := c.GetHeader("Content-Type")
	if strings.HasPrefix(ct, "multipart/") {
		category = c.PostForm("category")
		title = c.PostForm("title")
		party = c.PostForm("party")
		refNo = c.PostForm("reference_no")
		if s := c.PostForm("status"); s != "" {
			status = s
		}
		notes = c.PostForm("notes")
		externalURL = c.PostForm("external_url")
		projectID = parseUUIDPtr(c.PostForm("project_id"))
		userID = parseUUIDPtr(c.PostForm("user_id"))
		vendorID = parseUUIDPtr(c.PostForm("vendor_id"))
		effDate = parseDatePtr(c.PostForm("effective_date"))
		expDate = parseDatePtr(c.PostForm("expires_at"))
		signedAt = parseTimePtr(c.PostForm("signed_at"))
		if s := c.PostForm("tags"); s != "" {
			for _, t := range strings.Split(s, ",") {
				if t = strings.TrimSpace(t); t != "" {
					tags = append(tags, t)
				}
			}
		}
		// File is optional.
		fh, err := c.FormFile("file")
		if err == nil && fh != nil {
			filename = fh.Filename
			contentType = fh.Header.Get("Content-Type")
			content, err = readMultipart(fh)
			if err != nil {
				c.JSON(400, gin.H{"error": "could not read uploaded file: " + err.Error()})
				return
			}
		}
	} else {
		// JSON path — link-only or programmatic create.
		var req struct {
			Category, Title, Party, ReferenceNo string
			Status                              string
			Notes, ExternalURL                  string
			ProjectID, UserID, VendorID         string
			EffectiveDate, ExpiresAt            string
			SignedAt                            string
			Tags                                []string
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		category = req.Category
		title = req.Title
		party = req.Party
		refNo = req.ReferenceNo
		if req.Status != "" {
			status = req.Status
		}
		notes = req.Notes
		externalURL = req.ExternalURL
		projectID = parseUUIDPtr(req.ProjectID)
		userID = parseUUIDPtr(req.UserID)
		vendorID = parseUUIDPtr(req.VendorID)
		effDate = parseDatePtr(req.EffectiveDate)
		expDate = parseDatePtr(req.ExpiresAt)
		signedAt = parseTimePtr(req.SignedAt)
		tags = req.Tags
	}

	title = strings.TrimSpace(title)
	if title == "" {
		c.JSON(400, gin.H{"error": "title is required"})
		return
	}
	if validLegalCategories[category] == "" {
		c.JSON(400, gin.H{"error": "invalid category"})
		return
	}
	if !validLegalStatus[status] {
		c.JSON(400, gin.H{"error": "invalid status"})
		return
	}

	var id uuid.UUID
	sizeBytes := int64(len(content))
	if err := h.db.QueryRow(c, `
		INSERT INTO legal_documents (
		  tenant_id, category, title, party, reference_no,
		  project_id, user_id, vendor_id,
		  status, effective_date, expires_at, signed_at,
		  filename, content_type, size_bytes, content, external_url,
		  notes, tags, uploaded_by
		) VALUES (
		  $1, $2, $3, NULLIF($4,''), NULLIF($5,''),
		  $6, $7, $8,
		  $9, $10, $11, $12,
		  NULLIF($13,''), NULLIF($14,''), $15, $16, NULLIF($17,''),
		  NULLIF($18,''), COALESCE($19, '{}'::text[]), $20
		) RETURNING id`,
		tid, category, title, party, refNo,
		projectID, userID, vendorID,
		status, effDate, expDate, signedAt,
		filename, contentType, sizeBytes, content, externalURL,
		notes, tags, uid,
	).Scan(&id); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

// Get returns a single doc (metadata only — content is fetched via Download).
func (h *Legals) Get(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var (
		category, title, party, refNo string
		status                        string
		effDate, expDate, signedAt    *time.Time
		filename, contentType         string
		sizeBytes                     int64
		hasContent                    bool
		externalURL, notes            string
		tags                          []string
		version                       int
		createdAt, updatedAt          time.Time
	)
	if err := h.db.QueryRow(c, `
		SELECT category, title, COALESCE(party,''), COALESCE(reference_no,''),
		       status, effective_date, expires_at, signed_at,
		       COALESCE(filename,''), COALESCE(content_type,''),
		       size_bytes, (content IS NOT NULL), COALESCE(external_url,''),
		       COALESCE(notes,''), tags, version, created_at, updated_at
		FROM legal_documents WHERE id=$1 AND tenant_id=$2`, id, tid).Scan(
		&category, &title, &party, &refNo,
		&status, &effDate, &expDate, &signedAt,
		&filename, &contentType, &sizeBytes, &hasContent, &externalURL,
		&notes, &tags, &version, &createdAt, &updatedAt); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(200, gin.H{
		"id":             id,
		"category":       category,
		"category_label": validLegalCategories[category],
		"title":          title,
		"party":          party,
		"reference_no":   refNo,
		"status":         status,
		"effective_date": dateOrNil(effDate),
		"expires_at":     dateOrNil(expDate),
		"signed_at":      signedAt,
		"filename":       filename,
		"content_type":   contentType,
		"size_bytes":     sizeBytes,
		"has_content":    hasContent,
		"external_url":   externalURL,
		"notes":          notes,
		"tags":           tags,
		"version":        version,
		"created_at":     createdAt,
		"updated_at":     updatedAt,
	})
}

// Update — PATCH a subset of fields. Only fields present in the JSON
// body get touched; everything else keeps its previous value.
func (h *Legals) Update(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct {
		Title         *string  `json:"title"`
		Party         *string  `json:"party"`
		ReferenceNo   *string  `json:"reference_no"`
		Category      *string  `json:"category"`
		Status        *string  `json:"status"`
		Notes         *string  `json:"notes"`
		EffectiveDate *string  `json:"effective_date"`
		ExpiresAt     *string  `json:"expires_at"`
		SignedAt      *string  `json:"signed_at"`
		ExternalURL   *string  `json:"external_url"`
		ProjectID     *string  `json:"project_id"`
		UserID        *string  `json:"user_id"`
		VendorID      *string  `json:"vendor_id"`
		Tags          []string `json:"tags"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if req.Category != nil && validLegalCategories[*req.Category] == "" {
		c.JSON(400, gin.H{"error": "invalid category"})
		return
	}
	if req.Status != nil && !validLegalStatus[*req.Status] {
		c.JSON(400, gin.H{"error": "invalid status"})
		return
	}
	// Each field assigned via COALESCE($N, existing). Date fields use
	// NULLIF($N,'') so an explicit "" clears the value without deleting it.
	if _, err := h.db.Exec(c, `
		UPDATE legal_documents SET
		  title          = COALESCE($3, title),
		  party          = CASE WHEN $4::text IS NULL THEN party          WHEN $4 = '' THEN NULL ELSE $4 END,
		  reference_no   = CASE WHEN $5::text IS NULL THEN reference_no   WHEN $5 = '' THEN NULL ELSE $5 END,
		  category       = COALESCE($6, category),
		  status         = COALESCE($7, status),
		  notes          = CASE WHEN $8::text IS NULL THEN notes          WHEN $8 = '' THEN NULL ELSE $8 END,
		  effective_date = CASE WHEN $9::text IS NULL THEN effective_date WHEN $9 = '' THEN NULL ELSE $9::date END,
		  expires_at     = CASE WHEN $10::text IS NULL THEN expires_at    WHEN $10 = '' THEN NULL ELSE $10::date END,
		  signed_at      = CASE WHEN $11::text IS NULL THEN signed_at     WHEN $11 = '' THEN NULL ELSE $11::timestamptz END,
		  external_url   = CASE WHEN $12::text IS NULL THEN external_url  WHEN $12 = '' THEN NULL ELSE $12 END,
		  project_id     = CASE WHEN $13::text IS NULL THEN project_id    WHEN $13 = '' THEN NULL ELSE $13::uuid END,
		  user_id        = CASE WHEN $14::text IS NULL THEN user_id       WHEN $14 = '' THEN NULL ELSE $14::uuid END,
		  vendor_id      = CASE WHEN $15::text IS NULL THEN vendor_id     WHEN $15 = '' THEN NULL ELSE $15::uuid END,
		  tags           = COALESCE($16, tags),
		  updated_at     = now()
		WHERE id=$1 AND tenant_id=$2`,
		id, tid,
		req.Title, req.Party, req.ReferenceNo, req.Category, req.Status, req.Notes,
		req.EffectiveDate, req.ExpiresAt, req.SignedAt, req.ExternalURL,
		req.ProjectID, req.UserID, req.VendorID, req.Tags,
	); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// Delete hard-removes the document.
func (h *Legals) Delete(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	if _, err := h.db.Exec(c, `DELETE FROM legal_documents WHERE id=$1 AND tenant_id=$2`, id, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// Download streams the file bytes. 404 when there's no content — the
// caller should check has_content on the list/get response first.
func (h *Legals) Download(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var (
		filename, contentType string
		content               []byte
	)
	if err := h.db.QueryRow(c, `
		SELECT COALESCE(filename,'document'), COALESCE(content_type,'application/octet-stream'), content
		FROM legal_documents WHERE id=$1 AND tenant_id=$2`, id, tid).Scan(&filename, &contentType, &content); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if len(content) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "no payload — this entry is link-only"})
		return
	}
	c.Header("Content-Disposition", `attachment; filename="`+filename+`"`)
	c.Data(200, contentType, content)
}

// ---------- helpers (file-local to keep tidy) ----------

func parseUUIDPtr(s string) *uuid.UUID {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	id, err := uuid.Parse(s)
	if err != nil {
		return nil
	}
	return &id
}

func parseDatePtr(s string) *time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return nil
	}
	return &t
}

func parseTimePtr(s string) *time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		// Fall back to date-only for client convenience.
		t, err = time.Parse("2006-01-02", s)
		if err != nil {
			return nil
		}
	}
	return &t
}

func readMultipart(fh *multipart.FileHeader) ([]byte, error) {
	f, err := fh.Open()
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

func derefStrL(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
