package handlers

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	authpkg "github.com/decapods/pgdp/backend/internal/auth"
	"github.com/decapods/pgdp/backend/internal/audit"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/notifications"
	"github.com/decapods/pgdp/backend/internal/platform/config"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Members exposes the workspace's user roster — the people who can sign in to
// the app, distinct from `stakeholders` (external contacts on opportunities)
// and `agents` (introducers/PR partners). One tenant per row, role-gated writes.
type Members struct {
	db     *pgxpool.Pool
	mailer *notifications.Mailer
	cfg    *config.Config
}

func NewMembers(db *pgxpool.Pool) *Members { return &Members{db: db} }

// WithMailer attaches the SMTP mailer + config so CreateInvite can email the
// invitee. Optional — without it, invites still mint tokens (the app's existing
// "copy link" UX continues to work).
func (h *Members) WithMailer(m *notifications.Mailer, cfg *config.Config) *Members {
	h.mailer = m
	h.cfg = cfg
	return h
}

/* ---------------- List / Get / Create / Update / Disable / Enable ---------------- */

// List returns every user in the tenant with their roles, status, MFA flag and
// last login. Optional filters: status, role, q (substring on email/name).
func (h *Members) List(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	args := []any{tid}
	q := `
		SELECT u.id, u.email, COALESCE(u.full_name,''), u.status, u.mfa_enabled,
		       u.last_login_at, u.created_at, u.last_seen_at,
		       u.manual_status, u.manual_status_until,
		       COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
		FROM users u
		LEFT JOIN user_roles ur ON ur.user_id = u.id
		LEFT JOIN roles r       ON r.id = ur.role_id
		WHERE u.tenant_id=$1 AND u.deleted_at IS NULL`
	if s := c.Query("status"); s == "active" || s == "disabled" || s == "invited" {
		args = append(args, s)
		q += " AND u.status=$" + strconv.Itoa(len(args))
	}
	if role := c.Query("role"); role != "" {
		args = append(args, role)
		q += " AND EXISTS (SELECT 1 FROM user_roles ur2 JOIN roles r2 ON r2.id=ur2.role_id WHERE ur2.user_id=u.id AND r2.name=$" + strconv.Itoa(len(args)) + ")"
	}
	if needle := c.Query("q"); needle != "" {
		args = append(args, "%"+needle+"%")
		q += " AND (u.email::text ILIKE $" + strconv.Itoa(len(args)) +
			" OR u.full_name ILIKE $" + strconv.Itoa(len(args)) + ")"
	}
	q += " GROUP BY u.id ORDER BY u.created_at DESC LIMIT 500"

	rows, err := h.db.Query(c, q, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id                          uuid.UUID
			email, name, status         string
			mfa                         bool
			lastLogin, lastSeen         *time.Time
			manual                      *string
			manualUntil                 *time.Time
			created                     time.Time
			roles                       []string
		)
		if err := rows.Scan(&id, &email, &name, &status, &mfa, &lastLogin, &created, &lastSeen,
			&manual, &manualUntil, &roles); err == nil {
			// Single source of truth for presence — see derivePresence in me.go.
			presence := derivePresence(manual, manualUntil, lastSeen)
			var sinceSec int64 = -1
			if lastSeen != nil {
				sinceSec = int64(time.Since(*lastSeen).Seconds())
			}
			out = append(out, gin.H{
				"id": id, "email": email, "name": name, "status": status,
				"mfa_enabled": mfa, "last_login_at": lastLogin, "created_at": created,
				"roles": roles,
				"last_seen_at": lastSeen,
				"presence":     presence,
				"seconds_since": sinceSec,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

// ListRoles returns roles available in this tenant — system roles (tenant_id IS NULL)
// plus any tenant-specific ones. Used by the create/edit dialogs.
func (h *Members) ListRoles(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c, `
		SELECT id, name, COALESCE(description,''), tenant_id IS NULL AS is_system
		FROM roles
		WHERE tenant_id IS NULL OR tenant_id=$1
		ORDER BY (tenant_id IS NULL) DESC, name ASC`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id uuid.UUID
		var name, desc string
		var isSystem bool
		if err := rows.Scan(&id, &name, &desc, &isSystem); err == nil {
			out = append(out, gin.H{"id": id, "name": name, "description": desc, "is_system": isSystem})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

// Create provisions a new user in the tenant. Generates a one-time password,
// hashes it with argon2id, and returns the plain-text password ONCE so the
// admin can hand it over (or paste into a delivery channel). Status starts as
// "invited" so they show up distinctly until the first login.
func (h *Members) Create(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Email string   `json:"email" binding:"required,email"`
		Name  string   `json:"name"  binding:"required,min=2"`
		Roles []string `json:"roles"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	req.Name = strings.TrimSpace(req.Name)

	// One-shot temp password — 16 url-safe chars, plenty of entropy.
	pwBytes := make([]byte, 12)
	if _, err := rand.Read(pwBytes); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	tempPassword := base64.RawURLEncoding.EncodeToString(pwBytes)
	hash, err := authpkg.HashPassword(tempPassword)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }

	tx, err := h.db.Begin(c)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	defer tx.Rollback(c)

	var uid uuid.UUID
	if err := tx.QueryRow(c, `
		INSERT INTO users (tenant_id, email, full_name, password_hash, status)
		VALUES ($1,$2,$3,$4,'invited') RETURNING id`,
		tid, req.Email, req.Name, hash).Scan(&uid); err != nil {
		// likely unique-violation on email
		c.JSON(409, gin.H{"error": "Email already in use in this workspace.", "code": "email_taken"})
		return
	}

	// Resolve role names → role IDs (tenant or system) and insert mappings.
	if len(req.Roles) > 0 {
		rrows, err := tx.Query(c, `
			SELECT id, name FROM roles
			WHERE name = ANY($1) AND (tenant_id IS NULL OR tenant_id=$2)`,
			req.Roles, tid)
		if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
		ids := []uuid.UUID{}
		for rrows.Next() {
			var rid uuid.UUID; var rname string
			if err := rrows.Scan(&rid, &rname); err == nil { ids = append(ids, rid) }
		}
		rrows.Close()
		for _, rid := range ids {
			if _, err := tx.Exec(c, `INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, uid, rid); err != nil {
				c.JSON(500, gin.H{"error": err.Error()})
				return
			}
		}
	}
	if err := tx.Commit(c); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }

	audit.Write(c.Request.Context(), h.db, tid, &actor, "member.created", "user", uid, gin.H{
		"email": req.Email, "name": req.Name, "roles": req.Roles,
	})

	c.JSON(201, gin.H{
		"id":             uid,
		"email":          req.Email,
		"temp_password":  tempPassword,
		"warning":        "This temporary password is shown ONCE. Send it to the new member through a secure channel.",
	})
}

// Update patches name / status / roles. Roles are replaced wholesale when
// provided so the UI can drive a checkbox set without thinking about diffs.
func (h *Members) Update(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }
	var req struct {
		Name   *string   `json:"name"`
		Status *string   `json:"status"` // active | disabled | invited
		Roles  *[]string `json:"roles"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }

	tx, err := h.db.Begin(c)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	defer tx.Rollback(c)

	if req.Name != nil || req.Status != nil {
		sets := []string{"updated_at=now()"}
		args := []any{}
		add := func(col string, v any) { args = append(args, v); sets = append(sets, col+"=$"+strconv.Itoa(len(args))) }
		if req.Name != nil { add("full_name", strings.TrimSpace(*req.Name)) }
		if req.Status != nil {
			if *req.Status != "active" && *req.Status != "disabled" && *req.Status != "invited" {
				c.JSON(400, gin.H{"error": "invalid status"})
				return
			}
			add("status", *req.Status)
		}
		args = append(args, id, tid)
		q := "UPDATE users SET " + strings.Join(sets, ", ") +
			" WHERE id=$" + strconv.Itoa(len(args)-1) + " AND tenant_id=$" + strconv.Itoa(len(args)) + " AND deleted_at IS NULL"
		if _, err := tx.Exec(c, q, args...); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
	}

	if req.Roles != nil {
		// Confirm the user belongs to this tenant before touching roles.
		var owner uuid.UUID
		if err := tx.QueryRow(c, `SELECT tenant_id FROM users WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&owner); err != nil || owner != tid {
			c.JSON(404, gin.H{"error": "member not found"})
			return
		}
		// Replace the whole set.
		if _, err := tx.Exec(c, `DELETE FROM user_roles WHERE user_id=$1`, id); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		if len(*req.Roles) > 0 {
			rrows, err := tx.Query(c, `
				SELECT id FROM roles
				WHERE name = ANY($1) AND (tenant_id IS NULL OR tenant_id=$2)`,
				*req.Roles, tid)
			if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
			ids := []uuid.UUID{}
			for rrows.Next() {
				var rid uuid.UUID
				if err := rrows.Scan(&rid); err == nil { ids = append(ids, rid) }
			}
			rrows.Close()
			for _, rid := range ids {
				if _, err := tx.Exec(c, `INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, id, rid); err != nil {
					c.JSON(500, gin.H{"error": err.Error()})
					return
				}
			}
		}
	}
	if err := tx.Commit(c); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	audit.Write(c.Request.Context(), h.db, tid, &actor, "member.updated", "user", id, gin.H{
		"name": req.Name, "status": req.Status, "roles": req.Roles,
	})
	c.JSON(200, gin.H{"ok": true})
}

// ResetPassword issues a fresh one-time password the same way Create does,
// hashes + stores it, and returns the plain text once. Useful when a member
// loses their credentials before email delivery is wired up.
func (h *Members) ResetPassword(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }
	pwBytes := make([]byte, 12)
	if _, err := rand.Read(pwBytes); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	tempPassword := base64.RawURLEncoding.EncodeToString(pwBytes)
	hash, err := authpkg.HashPassword(tempPassword)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	res, err := h.db.Exec(c, `
		UPDATE users SET password_hash=$1, status='invited', updated_at=now()
		WHERE id=$2 AND tenant_id=$3 AND deleted_at IS NULL`,
		hash, id, tid)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	if res.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "member not found"})
		return
	}
	audit.Write(c.Request.Context(), h.db, tid, &actor, "member.password_reset", "user", id, nil)
	c.JSON(200, gin.H{
		"temp_password": tempPassword,
		"warning":       "This temporary password is shown ONCE. Send it through a secure channel.",
	})
}

// Delete soft-deletes a member. Self-delete is blocked — admins must hand the
// keys over before removing themselves.
func (h *Members) Delete(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }
	if id == uid {
		c.JSON(400, gin.H{"error": "You can't delete yourself.", "code": "self_delete"})
		return
	}
	if _, err := h.db.Exec(c, `
		UPDATE users SET deleted_at=now(), status='disabled' WHERE id=$1 AND tenant_id=$2`,
		id, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	audit.Write(c.Request.Context(), h.db, tid, &uid, "member.deleted", "user", id, nil)
	c.JSON(200, gin.H{"ok": true})
}

/* ---------------- Email-style invitations ----------------
 *
 * Admin creates an invite for a not-yet-existing user. Returns a token + URL
 * that the admin can copy or dispatch via mail client. The invitee opens the
 * public link, picks their own password, and a `users` row is provisioned in
 * one transaction. Until accepted, the user does NOT exist in the directory.
 */

const memberInviteTTL = 5 * 24 * time.Hour

// CreateInvite mints an invite. Body: { email, name, roles?, message? }
func (h *Members) CreateInvite(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Email   string   `json:"email"   binding:"required,email"`
		Name    string   `json:"name"    binding:"required,min=2"`
		Roles   []string `json:"roles"`
		Message string   `json:"message"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	req.Name = strings.TrimSpace(req.Name)
	if req.Roles == nil { req.Roles = []string{} }

	// Reject if a member with that email already exists in this tenant.
	var existing uuid.UUID
	if err := h.db.QueryRow(c,
		`SELECT id FROM users WHERE tenant_id=$1 AND lower(email::text)=$2 AND deleted_at IS NULL`,
		tid, req.Email).Scan(&existing); err == nil {
		c.JSON(409, gin.H{"error": "A member with that email already exists.", "code": "email_taken"})
		return
	}

	// Refuse to mint a second invite if one is already pending — caller should
	// use "Resend" on the existing invitation instead. This avoids the inbox
	// seeing two different links for the same person and accidental token
	// fan-out. Expired/revoked/accepted invites are ignored (a new one is fine).
	var pendingID uuid.UUID
	if err := h.db.QueryRow(c, `
		SELECT id FROM member_invitations
		 WHERE tenant_id=$1 AND lower(email::text)=$2
		   AND accepted_at IS NULL AND revoked_at IS NULL
		   AND expires_at > now()
		 LIMIT 1`, tid, req.Email).Scan(&pendingID); err == nil {
		c.JSON(409, gin.H{
			"error":     "An invitation has already been sent to that address. Use Resend to email it again.",
			"code":      "invite_exists",
			"invite_id": pendingID,
		})
		return
	}

	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	token := base64.RawURLEncoding.EncodeToString(buf)
	expires := time.Now().Add(memberInviteTTL)

	if _, err := h.db.Exec(c, `
		INSERT INTO member_invitations (tenant_id, token, email, full_name, roles, message, expires_at, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		tid, token, req.Email, req.Name, req.Roles, req.Message, expires, uid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Fire-and-forget invite email. The "copy link" flow on the frontend keeps
	// working regardless of mailer state.
	h.dispatchMemberInviteEmail(c.Request.Context(), tid, req.Email, req.Name, token, req.Message)

	// Audit row keys on the invitation token (deterministic) instead of a UUID
	// we don't have — store metadata in the diff for the page to render.
	audit.Write(c.Request.Context(), h.db, tid, &uid, "member.invited", "invitation", uuid.Nil, gin.H{
		"email": req.Email, "name": req.Name, "roles": req.Roles,
	})

	c.JSON(201, gin.H{
		"token":      token,
		"email":      req.Email,
		"name":       req.Name,
		"expires_at": expires,
	})
}

func (h *Members) dispatchMemberInviteEmail(ctx context.Context, tid uuid.UUID, to, name, token, personalMsg string) {
	if h.mailer == nil || !h.mailer.Configured() {
		return
	}
	company := loadCompanyHeader(ctx, h.db, tid)
	publicBase := publicBaseURL(h.cfg)
	link := fmt.Sprintf("%s/member-invite/%s", publicBase, token)

	subject := fmt.Sprintf("You're invited to %s", company.DisplayName())
	plain := fmt.Sprintf(
		"Hi %s,\n\n%s has invited you to join their workspace on D'Accubin.\n\nAccept the invite:\n%s\n\n%s\n\nThis link expires in 5 days.",
		name, company.DisplayName(), link, strings.TrimSpace(personalMsg),
	)
	html := buildInviteHTML(company, name, link, personalMsg)

	go func(em notifications.Email) {
		if err := h.mailer.Send(context.Background(), em); err != nil {
			slog.Warn("member invite email failed", "to", em.To, "err", err)
		}
	}(notifications.Email{To: to, Subject: subject, Plain: plain, HTML: html})
}

// ---- Small shared helpers (not coupled to Members) ----

type companyHeader struct {
	Name      string
	LogoURL   string
	WebsiteURL string
}

func (c companyHeader) DisplayName() string {
	if strings.TrimSpace(c.Name) != "" {
		return c.Name
	}
	return "your D'Accubin workspace"
}

func loadCompanyHeader(ctx context.Context, db *pgxpool.Pool, tid uuid.UUID) companyHeader {
	out := companyHeader{}
	var raw []byte
	if err := db.QueryRow(ctx, `SELECT settings FROM tenants WHERE id=$1`, tid).Scan(&raw); err != nil || len(raw) == 0 {
		return out
	}
	var s map[string]any
	_ = json.Unmarshal(raw, &s)
	if v, ok := s["company_name"].(string); ok { out.Name = v }
	if v, ok := s["logo_url"].(string); ok { out.LogoURL = v }
	if v, ok := s["website_url"].(string); ok { out.WebsiteURL = v }
	return out
}

func publicBaseURL(cfg *config.Config) string {
	if cfg != nil && len(cfg.AllowedOrigins) > 0 {
		o := strings.TrimSpace(cfg.AllowedOrigins[0])
		o = strings.TrimSuffix(o, "/")
		if o != "" && o != "*" {
			return o
		}
	}
	return "https://myaccubin.com"
}

func buildInviteHTML(co companyHeader, name, link, msg string) string {
	logo := ""
	if strings.TrimSpace(co.LogoURL) != "" {
		logo = fmt.Sprintf(`<img src="%s" alt="" style="max-height:40px;margin-bottom:12px"/>`, co.LogoURL)
	}
	personal := ""
	if strings.TrimSpace(msg) != "" {
		personal = fmt.Sprintf(`<blockquote style="border-left:3px solid #e5e7eb;padding:6px 12px;margin:14px 0;color:#475569">%s</blockquote>`, htmlEscape(msg))
	}
	return fmt.Sprintf(`<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937">
<div style="max-width:560px;margin:24px auto;padding:24px;border:1px solid #e5e7eb;border-radius:14px;background:#faf7f1">
%s
<h1 style="margin:0 0 8px;font-size:22px;color:#0f172a">You're invited to %s</h1>
<p style="margin:0 0 14px">Hi %s — you've been invited to join the workspace on D'Accubin.</p>
%s
<p style="margin:0 0 18px"><a href="%s" style="background:#0F7B97;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Accept the invite</a></p>
<p style="font-size:12px;color:#64748b;margin:0">Or paste this URL into your browser:<br/><a href="%s">%s</a></p>
<p style="font-size:11px;color:#94a3b8;margin-top:18px">This link expires in 5 days.</p>
</div></body></html>`, logo, htmlEscape(co.DisplayName()), htmlEscape(name), personal, link, link, link)
}

func htmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}

// ListInvites returns pending + recent invites, useful as a "people we've
// emailed but haven't joined yet" view.
func (h *Members) ListInvites(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c, `
		SELECT id, token, email::text, full_name, roles, COALESCE(message,''),
		       created_at, expires_at, accepted_at, revoked_at
		FROM member_invitations
		WHERE tenant_id=$1
		ORDER BY created_at DESC LIMIT 100`, tid)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id                                           uuid.UUID
			token, email, name, msg                      string
			roles                                        []string
			created, expires                             time.Time
			accepted, revoked                            *time.Time
		)
		if err := rows.Scan(&id, &token, &email, &name, &roles, &msg,
			&created, &expires, &accepted, &revoked); err == nil {
			status := "pending"
			if revoked != nil { status = "revoked" } else if accepted != nil { status = "accepted" } else if time.Now().After(expires) { status = "expired" }
			out = append(out, gin.H{
				"id": id, "token": token, "email": email, "name": name,
				"roles": roles, "message": msg,
				"created_at": created, "expires_at": expires,
				"accepted_at": accepted, "revoked_at": revoked, "status": status,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

// RevokeInvite cancels a pending invite so its link can no longer be used.
// ResendInvite re-fires the invite email for an existing pending invitation.
// Same token, same link — just dispatches the email again. Extends the expiry
// to a fresh 5 days so a near-stale invite becomes useful again. 410 if the
// invite is already accepted or revoked.
func (h *Members) ResendInvite(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	invID, err := uuid.Parse(c.Param("inviteId"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }

	var (
		token, email, name, msg string
		expires                 time.Time
		accepted, revoked       *time.Time
	)
	err = h.db.QueryRow(c, `
		SELECT token, email::text, full_name, COALESCE(message,''), expires_at, accepted_at, revoked_at
		FROM member_invitations
		WHERE id=$1 AND tenant_id=$2`, invID, tid).Scan(
		&token, &email, &name, &msg, &expires, &accepted, &revoked,
	)
	if err != nil {
		c.JSON(404, gin.H{"error": "invitation not found"})
		return
	}
	switch {
	case revoked != nil:
		c.JSON(410, gin.H{"error": "Invitation has been revoked. Issue a fresh invite instead.", "code": "revoked"}); return
	case accepted != nil:
		c.JSON(410, gin.H{"error": "Invitation already accepted — they have an account.", "code": "accepted"}); return
	}

	// Refresh expiry so the resend isn't pointless.
	newExpiry := time.Now().Add(memberInviteTTL)
	if _, err := h.db.Exec(c,
		`UPDATE member_invitations SET expires_at=$1 WHERE id=$2 AND tenant_id=$3`,
		newExpiry, invID, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Dispatch the email again. Same token, fresh window.
	h.dispatchMemberInviteEmail(c.Request.Context(), tid, email, name, token, msg)

	audit.Write(c.Request.Context(), h.db, tid, &actor, "member.invite_resent", "invitation", invID, gin.H{
		"email": email,
	})

	c.JSON(200, gin.H{
		"ok":         true,
		"email":      email,
		"expires_at": newExpiry,
		"sent":       h.mailer != nil && h.mailer.Configured(),
	})
}

func (h *Members) RevokeInvite(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	invID, err := uuid.Parse(c.Param("inviteId"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }
	if _, err := h.db.Exec(c,
		`UPDATE member_invitations SET revoked_at=now()
		 WHERE id=$1 AND tenant_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL`,
		invID, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	audit.Write(c.Request.Context(), h.db, tid, &actor, "member.invite_revoked", "invitation", invID, nil)
	c.JSON(200, gin.H{"ok": true})
}

// DeleteInvite hard-deletes an invitation row. Only allowed when the invite is
// no longer live — i.e. revoked, accepted (rare, usually we keep history), or
// expired. The UI surfaces a confirm modal because this is destructive and
// can't be undone (the token is gone forever). Live/pending invites must be
// revoked first; we refuse with 409 so the caller can show a clear message.
func (h *Members) DeleteInvite(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	actor := c.MustGet(mw.CtxUserID).(uuid.UUID)
	invID, err := uuid.Parse(c.Param("inviteId"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }

	var (
		email             string
		expires           time.Time
		accepted, revoked *time.Time
	)
	if err := h.db.QueryRow(c, `
		SELECT email::text, expires_at, accepted_at, revoked_at
		FROM member_invitations WHERE id=$1 AND tenant_id=$2`,
		invID, tid).Scan(&email, &expires, &accepted, &revoked); err != nil {
		c.JSON(404, gin.H{"error": "invitation not found"})
		return
	}
	live := revoked == nil && accepted == nil && time.Now().Before(expires)
	if live {
		c.JSON(409, gin.H{
			"error": "Revoke the invitation before deleting — it's still active.",
			"code":  "invite_live",
		})
		return
	}
	if _, err := h.db.Exec(c,
		`DELETE FROM member_invitations WHERE id=$1 AND tenant_id=$2`, invID, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	audit.Write(c.Request.Context(), h.db, tid, &actor, "member.invite_deleted", "invitation", invID, gin.H{
		"email": email,
	})
	c.JSON(200, gin.H{"ok": true})
}

// PublicGetInvite returns the public-safe details of an invite given its token.
// GET /member-invite/:token   (no auth)
func (h *Members) PublicGetInvite(c *gin.Context) {
	token := c.Param("token")
	if token == "" { c.JSON(400, gin.H{"error": "missing token"}); return }
	var (
		tid                       uuid.UUID
		email, name, msg, tenant  string
		roles                     []string
		expires                   time.Time
		accepted, revoked         *time.Time
	)
	err := h.db.QueryRow(c, `
		SELECT i.tenant_id, i.email::text, i.full_name, i.roles, COALESCE(i.message,''),
		       i.expires_at, i.accepted_at, i.revoked_at,
		       COALESCE(t.name,'')
		FROM member_invitations i
		JOIN tenants t ON t.id = i.tenant_id
		WHERE i.token=$1`, token).Scan(
		&tid, &email, &name, &roles, &msg, &expires, &accepted, &revoked, &tenant,
	)
	if err != nil { c.JSON(404, gin.H{"error": "invitation not found"}); return }
	switch {
	case revoked != nil:
		c.JSON(410, gin.H{"error": "This invitation has been revoked.", "code": "revoked"}); return
	case accepted != nil:
		c.JSON(410, gin.H{"error": "This invitation has already been accepted.", "code": "accepted"}); return
	case time.Now().After(expires):
		c.JSON(410, gin.H{"error": "This invitation has expired.", "code": "expired"}); return
	}
	c.JSON(200, gin.H{
		"email":         email,
		"name":          name,
		"roles":         roles,
		"message":       msg,
		"workspace":     tenant,
		"expires_at":    expires,
	})
}

// PublicAcceptInvite — invitee submits their chosen password. We create the
// `users` row, attach their roles, mark the invite accepted. Single transaction.
// POST /member-invite/:token   (no auth)
func (h *Members) PublicAcceptInvite(c *gin.Context) {
	token := c.Param("token")
	if token == "" { c.JSON(400, gin.H{"error": "missing token"}); return }
	var req struct {
		Password string `json:"password" binding:"required,min=10"`
		Name     string `json:"name"` // optional override of the invited name
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	// Look up the invite.
	var (
		invID, tid                uuid.UUID
		email, fullName           string
		roles                     []string
		expires                   time.Time
		accepted, revoked         *time.Time
	)
	if err := h.db.QueryRow(c, `
		SELECT id, tenant_id, email::text, full_name, roles, expires_at, accepted_at, revoked_at
		FROM member_invitations WHERE token=$1`, token).Scan(
		&invID, &tid, &email, &fullName, &roles, &expires, &accepted, &revoked,
	); err != nil {
		c.JSON(404, gin.H{"error": "invitation not found"})
		return
	}
	switch {
	case revoked != nil:        c.JSON(410, gin.H{"error": "Invitation revoked.",  "code": "revoked"});  return
	case accepted != nil:       c.JSON(410, gin.H{"error": "Invitation already used.", "code": "accepted"}); return
	case time.Now().After(expires): c.JSON(410, gin.H{"error": "Invitation expired.", "code": "expired"}); return
	}

	// Race-check: someone may have created an account on this email while the
	// invite was pending. Fail closed if so.
	var existing uuid.UUID
	if err := h.db.QueryRow(c,
		`SELECT id FROM users WHERE tenant_id=$1 AND lower(email::text)=lower($2) AND deleted_at IS NULL`,
		tid, email).Scan(&existing); err == nil {
		c.JSON(409, gin.H{"error": "An account with that email already exists. Try signing in instead.", "code": "email_taken"})
		return
	}

	hash, err := authpkg.HashPassword(req.Password)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }

	// Use the override name if provided, otherwise stick with what the admin invited.
	chosenName := strings.TrimSpace(req.Name)
	if chosenName == "" { chosenName = fullName }

	tx, err := h.db.Begin(c)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	defer tx.Rollback(c)

	var newUserID uuid.UUID
	if err := tx.QueryRow(c, `
		INSERT INTO users (tenant_id, email, full_name, password_hash, status)
		VALUES ($1,$2,$3,$4,'active') RETURNING id`,
		tid, email, chosenName, hash).Scan(&newUserID); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Attach roles. Names → IDs, scoped to system roles or this tenant.
	if len(roles) > 0 {
		rrows, err := tx.Query(c, `
			SELECT id FROM roles
			WHERE name = ANY($1) AND (tenant_id IS NULL OR tenant_id=$2)`, roles, tid)
		if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
		ids := []uuid.UUID{}
		for rrows.Next() {
			var rid uuid.UUID
			if err := rrows.Scan(&rid); err == nil { ids = append(ids, rid) }
		}
		rrows.Close()
		for _, rid := range ids {
			if _, err := tx.Exec(c,
				`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
				newUserID, rid); err != nil {
				c.JSON(500, gin.H{"error": err.Error()})
				return
			}
		}
	}

	if _, err := tx.Exec(c,
		`UPDATE member_invitations SET accepted_at=now(), accepted_user_id=$1 WHERE id=$2`,
		newUserID, invID); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if err := tx.Commit(c); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }

	// Public action — actor is the new user themselves.
	audit.Write(c.Request.Context(), h.db, tid, &newUserID, "member.invite_accepted", "user", newUserID, gin.H{
		"email": email,
	})

	c.JSON(200, gin.H{"ok": true, "email": email})
}
