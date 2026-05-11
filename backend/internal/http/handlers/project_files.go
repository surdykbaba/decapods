// Package handlers — project_files.go
//
// First-class project file storage. Distinct from opportunity-level statutory
// documents (which live on the source opportunity), this is for working
// artefacts a project manager actually deals with day-to-day: change
// requests, architecture diagrams, scope notes, design packs, meeting notes,
// etc.
//
// Bytes live inline as bytea — cheap, tenant-clean, easy to back up. The
// 25MB per-file cap is enforced both at the multipart parse step and as a
// last-line check before INSERT. Migrating to object storage later only
// touches this file; the rest of the platform treats files as opaque IDs.
package handlers

import (
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time" // for Time scan in List

	"github.com/decapods/pgdp/backend/internal/audit"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ProjectFiles struct{ db *pgxpool.Pool }

func NewProjectFiles(db *pgxpool.Pool) *ProjectFiles { return &ProjectFiles{db: db} }

const (
	maxFileBytes    = 25 * 1024 * 1024 // 25 MB hard cap per upload
	maxMemMultipart = 4 * 1024 * 1024  // 4 MB in-memory before disk spill
)

var (
	validKinds = map[string]bool{
		"architecture": true, "change_request": true, "scope": true,
		"design": true, "contract": true, "spec": true,
		"meeting_notes": true, "reference": true, "other": true,
	}
	validVisibility = map[string]bool{
		"workspace": true, "team": true, "leads": true, "private": true,
	}
	leadRoles = map[string]bool{
		"super_admin": true, "ceo": true, "coo": true,
		"delivery_manager": true, "project_manager": true,
	}
)

// canSeeFile evaluates the visibility rule for one row. Mirrors the SQL
// WHERE-clause used in List so the per-row download endpoint stays in sync.
func canSeeFile(
	visibility string,
	uploaderID, viewerID uuid.UUID,
	viewerRoles []string,
	isProjectMember bool,
) bool {
	switch visibility {
	case "workspace":
		return true
	case "team":
		return isProjectMember || hasLeadRole(viewerRoles) || uploaderID == viewerID
	case "leads":
		return hasLeadRole(viewerRoles) || uploaderID == viewerID
	case "private":
		return uploaderID == viewerID || hasLeadRole(viewerRoles)
	}
	return false
}

func hasLeadRole(roles []string) bool {
	for _, r := range roles {
		if leadRoles[r] {
			return true
		}
	}
	return false
}

// isProjectMember returns true when the caller is on project_members for the
// given project (active row, not removed). Used by the visibility check.
func (h *ProjectFiles) isProjectMember(c *gin.Context, projectID, userID uuid.UUID) bool {
	var ok bool
	_ = h.db.QueryRow(c, `
		SELECT EXISTS (
		  SELECT 1 FROM project_members
		   WHERE project_id=$1 AND user_id=$2 AND removed_at IS NULL
		)`, projectID, userID).Scan(&ok)
	return ok
}

// canManageProject — uploader and lead roles get full write access. Plain
// project members can only delete their own uploads.
func canManageProject(roles []string, uploaderID, viewerID uuid.UUID) bool {
	return hasLeadRole(roles) || uploaderID == viewerID
}

// List — GET /api/v1/projects/:id/files
//
// Returns visible files for the caller, sorted newest first. We filter at the
// SQL layer so a private file never leaves the database; the response is
// already a safe set the UI can render without further checks.
func (h *ProjectFiles) List(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)

	pid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	isMember := h.isProjectMember(c, pid, uid)
	lead := hasLeadRole(roles)

	rows, err := h.db.Query(c, `
		SELECT f.id, f.name, COALESCE(f.description,''), f.kind, f.visibility, f.tags,
		       f.mime, f.size_bytes, f.version,
		       f.uploaded_by, COALESCE(u.full_name,''), u.email::text,
		       f.created_at
		FROM project_files f
		JOIN users u ON u.id = f.uploaded_by
		WHERE f.tenant_id = $1 AND f.project_id = $2 AND f.deleted_at IS NULL
		  AND (
		    f.visibility = 'workspace'
		    OR (f.visibility = 'team'    AND ($3::bool OR $4::bool OR f.uploaded_by = $5))
		    OR (f.visibility = 'leads'   AND ($4::bool                 OR f.uploaded_by = $5))
		    OR (f.visibility = 'private' AND  f.uploaded_by = $5)
		  )
		ORDER BY f.created_at DESC`,
		tid, pid, isMember, lead, uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	out := []gin.H{}
	for rows.Next() {
		var (
			id, uploader               uuid.UUID
			name, desc, kind, vis      string
			mime                       *string
			size                       int64
			version                    int
			uploaderName, uploaderMail string
			tags                       []string
			created                    time.Time
		)
		if err := rows.Scan(&id, &name, &desc, &kind, &vis, &tags,
			&mime, &size, &version,
			&uploader, &uploaderName, &uploaderMail, &created); err == nil {
			mimeStr := ""
			if mime != nil {
				mimeStr = *mime
			}
			out = append(out, gin.H{
				"id":             id,
				"name":           name,
				"description":    desc,
				"kind":           kind,
				"visibility":     vis,
				"tags":           tags,
				"mime":           mimeStr,
				"size_bytes":     size,
				"version":        version,
				"uploaded_by":    uploader,
				"uploaded_by_name":  uploaderName,
				"uploaded_by_email": uploaderMail,
				"created_at":     created,
				"download_url":   "/api/v1/projects/" + pid.String() + "/files/" + id.String() + "/download",
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// Upload — POST /api/v1/projects/:id/files  (multipart/form-data)
//
// Fields:
//   file        — the binary, required
//   name        — display name (falls back to filename)
//   description — long-form notes
//   kind        — one of validKinds (default "other")
//   visibility  — one of validVisibility (default "team")
//   tags        — comma-separated free text
//
// The whole file is read into memory once (Gin's multipart parser already
// streams to a temp file behind the scenes for anything > maxMemMultipart).
// We then INSERT the bytes; bytea handles encoding.
func (h *ProjectFiles) Upload(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	pid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}

	// Cap the multipart body up-front so a 1 GB upload doesn't OOM the box
	// before we get a chance to refuse it.
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
	if kind == "" {
		kind = "other"
	}
	if !validKinds[kind] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid kind"})
		return
	}
	visibility := strings.TrimSpace(c.PostForm("visibility"))
	if visibility == "" {
		visibility = "team"
	}
	if !validVisibility[visibility] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid visibility"})
		return
	}

	name := strings.TrimSpace(c.PostForm("name"))
	if name == "" {
		name = fh.Filename
	}
	desc := strings.TrimSpace(c.PostForm("description"))

	// Tags arrive comma-separated. Trim + dedupe + cap at 8 so a misuse can't
	// blow out the row.
	rawTags := strings.Split(c.PostForm("tags"), ",")
	seen := map[string]bool{}
	tags := []string{}
	for _, t := range rawTags {
		t = strings.TrimSpace(t)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		tags = append(tags, t)
		if len(tags) >= 8 {
			break
		}
	}

	// Bump version when a file with the same name already lives on this
	// project. Old rows stay around (deleted_at IS NULL filter) so the file
	// list shows the full history.
	var prevMax int
	_ = h.db.QueryRow(c, `
		SELECT COALESCE(MAX(version),0) FROM project_files
		 WHERE project_id=$1 AND name=$2 AND deleted_at IS NULL`, pid, name).Scan(&prevMax)
	version := prevMax + 1

	// Read the whole body once. Gin's File() opens the temp file if it
	// spilled, otherwise hands back an in-memory reader — same interface.
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
		INSERT INTO project_files
		  (tenant_id, project_id, uploaded_by, name, description, kind, visibility, tags,
		   mime, size_bytes, content, version)
		VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8,NULLIF($9,''),$10,$11,$12)
		RETURNING id`,
		tid, pid, uid, name, desc, kind, visibility, tags,
		mime, int64(len(content)), content, version).Scan(&id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	audit.WriteHTTP(c, h.db, c, tid, &uid, "project.file.uploaded", "project_file", id, gin.H{
		"project_id": pid,
		"name":       name,
		"kind":       kind,
		"visibility": visibility,
		"size_bytes": len(content),
		"version":    version,
	})
	c.JSON(http.StatusCreated, gin.H{
		"id":         id,
		"name":       name,
		"kind":       kind,
		"visibility": visibility,
		"size_bytes": len(content),
		"version":    version,
	})
}

// Download — GET /api/v1/projects/:id/files/:fileId/download
//
// Streams the bytea back with the original filename in a
// Content-Disposition: attachment header. Re-runs the visibility check (the
// caller might have lost access since the list snapshot was taken).
func (h *ProjectFiles) Download(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)

	pid, err1 := uuid.Parse(c.Param("id"))
	fid, err2 := uuid.Parse(c.Param("fileId"))
	if err1 != nil || err2 != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}

	var (
		name, vis  string
		mime       *string
		content    []byte
		uploadedBy uuid.UUID
	)
	if err := h.db.QueryRow(c, `
		SELECT name, visibility, mime, content, uploaded_by
		FROM project_files
		WHERE id=$1 AND project_id=$2 AND tenant_id=$3 AND deleted_at IS NULL`,
		fid, pid, tid).Scan(&name, &vis, &mime, &content, &uploadedBy); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}
	if !canSeeFile(vis, uploadedBy, uid, roles, h.isProjectMember(c, pid, uid)) {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed to view this file"})
		return
	}

	mimeStr := "application/octet-stream"
	if mime != nil && *mime != "" {
		mimeStr = *mime
	}
	c.Header("Content-Disposition", `attachment; filename="`+escapeFilename(name)+`"`)
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, mimeStr, content)
}

// Update — PATCH /api/v1/projects/:id/files/:fileId
//
// Edit any of: name, description, kind, visibility, tags. Bytes never change
// here — that requires a fresh upload. Only the uploader and lead roles can
// edit; gated by canManageProject.
func (h *ProjectFiles) Update(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)

	pid, err1 := uuid.Parse(c.Param("id"))
	fid, err2 := uuid.Parse(c.Param("fileId"))
	if err1 != nil || err2 != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	var uploaderID uuid.UUID
	if err := h.db.QueryRow(c,
		`SELECT uploaded_by FROM project_files WHERE id=$1 AND project_id=$2 AND tenant_id=$3 AND deleted_at IS NULL`,
		fid, pid, tid).Scan(&uploaderID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}
	if !canManageProject(roles, uploaderID, uid) {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}

	var req struct {
		Name        *string  `json:"name"`
		Description *string  `json:"description"`
		Kind        *string  `json:"kind"`
		Visibility  *string  `json:"visibility"`
		Tags        []string `json:"tags"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Kind != nil && !validKinds[*req.Kind] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid kind"})
		return
	}
	if req.Visibility != nil && !validVisibility[*req.Visibility] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid visibility"})
		return
	}

	if _, err := h.db.Exec(c, `
		UPDATE project_files SET
		  name        = COALESCE($3, name),
		  description = COALESCE($4, description),
		  kind        = COALESCE($5, kind),
		  visibility  = COALESCE($6, visibility),
		  tags        = COALESCE($7, tags)
		WHERE id=$1 AND project_id=$2`,
		fid, pid, req.Name, req.Description, req.Kind, req.Visibility, req.Tags); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.WriteHTTP(c, h.db, c, tid, &uid, "project.file.updated", "project_file", fid, req)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Delete — DELETE /api/v1/projects/:id/files/:fileId
//
// Soft delete (deleted_at stamp). Uploader can always delete their own;
// lead roles can delete any.
func (h *ProjectFiles) Delete(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)

	pid, err1 := uuid.Parse(c.Param("id"))
	fid, err2 := uuid.Parse(c.Param("fileId"))
	if err1 != nil || err2 != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return
	}
	var uploaderID uuid.UUID
	if err := h.db.QueryRow(c,
		`SELECT uploaded_by FROM project_files WHERE id=$1 AND project_id=$2 AND tenant_id=$3 AND deleted_at IS NULL`,
		fid, pid, tid).Scan(&uploaderID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}
	if !canManageProject(roles, uploaderID, uid) {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	if _, err := h.db.Exec(c,
		`UPDATE project_files SET deleted_at=now() WHERE id=$1`, fid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.WriteHTTP(c, h.db, c, tid, &uid, "project.file.deleted", "project_file", fid, nil)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// openFormFile is a tiny indirection so the upload handler reads bytes the
// same way whether the multipart parser kept the body in memory or spilled
// it to a tempfile.
func openFormFile(fh *multipart.FileHeader) (multipart.File, error) {
	return fh.Open()
}

func escapeFilename(s string) string {
	// strip control chars + quotes; not RFC 5987 perfect but safe enough
	// for the headers we emit.
	return strings.NewReplacer(`"`, "", "\r", "", "\n", "", "\t", " ").Replace(s)
}

// guessMimeFromName provides a fallback when the browser's Content-Type was
// generic. We only need the common cases — PDF, images, office, archives.
func guessMimeFromName(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".pdf":
		return "application/pdf"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".svg":
		return "image/svg+xml"
	case ".csv":
		return "text/csv"
	case ".txt", ".md":
		return "text/plain"
	case ".doc":
		return "application/msword"
	case ".docx":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case ".xls":
		return "application/vnd.ms-excel"
	case ".xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case ".ppt":
		return "application/vnd.ms-powerpoint"
	case ".pptx":
		return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
	case ".zip":
		return "application/zip"
	}
	return "application/octet-stream"
}
