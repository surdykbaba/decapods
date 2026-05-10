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

type Agents struct {
	db *pgxpool.Pool
}

func NewAgents(db *pgxpool.Pool) *Agents { return &Agents{db: db} }

// AgentMandatoryDocs are the kinds that must be on file before an agent can
// be activated for engagements. PR / introducer relationships skew compliance-
// heavy because of bribery / PEP exposure, so the bar is intentionally higher
// than the vendor docset.
var AgentMandatoryDocs = []string{
	"nda",
	"engagement_agreement",
	"agent_declaration",
	"conflict_of_interest",
	"kyc",
	"anti_bribery",
	"approval_memo",
}

const agentInviteTTL = 14 * 24 * time.Hour

/* ---------------- List / Create / Get / Update / Delete ---------------- */

// List returns all non-deleted agents for the tenant with the computed fields
// the directory needs (mandatory-doc gate, doc count, owner name).
// Optional filters: status, agent_type, region, country, risk_level, sector, owner.
func (h *Agents) List(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	args := []any{tid}
	q := `SELECT a.id, a.name, COALESCE(a.organization,''), a.agent_type,
		COALESCE(a.contact_name,''), COALESCE(a.contact_email,''), COALESCE(a.contact_phone,''),
		COALESCE(a.region,''), COALESCE(a.country,''), a.sector_focus,
		a.relationship_owner, a.status, a.risk_level, a.pep_flag, a.conflict_flag,
		COALESCE(a.notes,''), a.last_activity_at, a.created_at,
		(SELECT COUNT(*) FROM agent_documents ad WHERE ad.agent_id=a.id) AS doc_count,
		(SELECT array_agg(DISTINCT ad.kind) FROM agent_documents ad WHERE ad.agent_id=a.id) AS doc_kinds,
		COALESCE(u.full_name,'') AS owner_name
		FROM agents a
		LEFT JOIN users u ON u.id = a.relationship_owner
		WHERE a.tenant_id=$1 AND a.deleted_at IS NULL`
	addFilter := func(col, val string) {
		args = append(args, val)
		q += " AND a." + col + "=$" + strconv.Itoa(len(args))
	}
	if v := c.Query("status");      v != "" { addFilter("status", v) }
	if v := c.Query("agent_type");  v != "" { addFilter("agent_type", v) }
	if v := c.Query("region");      v != "" { addFilter("region", v) }
	if v := c.Query("country");     v != "" { addFilter("country", v) }
	if v := c.Query("risk_level");  v != "" { addFilter("risk_level", v) }
	if v := c.Query("owner");       v != "" {
		args = append(args, v)
		q += " AND a.relationship_owner=$" + strconv.Itoa(len(args))
	}
	if v := c.Query("sector"); v != "" {
		args = append(args, v)
		q += " AND $" + strconv.Itoa(len(args)) + " = ANY(a.sector_focus)"
	}
	q += " ORDER BY a.created_at DESC"

	rows, err := h.db.Query(c, q, args...)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	defer rows.Close()

	out := []gin.H{}
	for rows.Next() {
		var (
			id, kind, status, risk, name, org, cn, ce, cp, region, country, notes, ownerName string
			sectors, docKinds                                                                  []string
			ownerID                                                                             *uuid.UUID
			pep, conflict                                                                       bool
			lastAct                                                                             *time.Time
			created                                                                             time.Time
			docCount                                                                            int
		)
		if err := rows.Scan(&id, &name, &org, &kind, &cn, &ce, &cp, &region, &country, &sectors,
			&ownerID, &status, &risk, &pep, &conflict, &notes, &lastAct, &created,
			&docCount, &docKinds, &ownerName); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		have := map[string]bool{}
		for _, k := range docKinds { have[k] = true }
		missing := []string{}
		for _, k := range AgentMandatoryDocs {
			if !have[k] { missing = append(missing, k) }
		}
		out = append(out, gin.H{
			"id": id, "name": name, "organization": org, "agent_type": kind,
			"contact_name": cn, "contact_email": ce, "contact_phone": cp,
			"region": region, "country": country, "sector_focus": sectors,
			"relationship_owner_id":   ownerID,
			"relationship_owner_name": ownerName,
			"status": status, "risk_level": risk,
			"pep_flag": pep, "conflict_flag": conflict,
			"notes": notes,
			"last_activity_at": lastAct, "created_at": created,
			"document_count": docCount, "document_kinds": docKinds,
			"mandatory_missing": missing,
			"can_engage":        len(missing) == 0,
			// Stubs — wired up when engagements / introductions / commissions ship.
			"active_engagements_count": 0,
			"introductions_count":      0,
			"commission_exposure":      0,
		})
	}
	c.JSON(200, gin.H{"items": out, "mandatory_kinds": AgentMandatoryDocs})
}

func (h *Agents) Create(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Name              string     `json:"name"`
		Organization      string     `json:"organization"`
		AgentType         string     `json:"agent_type"`
		ContactName       string     `json:"contact_name"`
		ContactEmail      string     `json:"contact_email"`
		ContactPhone      string     `json:"contact_phone"`
		Region            string     `json:"region"`
		Country           string     `json:"country"`
		SectorFocus       []string   `json:"sector_focus"`
		RelationshipOwner *uuid.UUID `json:"relationship_owner"`
		RiskLevel         string     `json:"risk_level"`
		PEPFlag           bool       `json:"pep_flag"`
		ConflictFlag      bool       `json:"conflict_flag"`
		Notes             string     `json:"notes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" { c.JSON(400, gin.H{"error": "name is required"}); return }
	if req.AgentType == "" { req.AgentType = "relationship_agent" }
	if req.RiskLevel == "" { req.RiskLevel = "low" }
	if req.SectorFocus == nil { req.SectorFocus = []string{} }

	var id uuid.UUID
	if err := h.db.QueryRow(c, `
		INSERT INTO agents (tenant_id, name, organization, agent_type, contact_name, contact_email, contact_phone,
		  region, country, sector_focus, relationship_owner, risk_level, pep_flag, conflict_flag, notes,
		  last_activity_at, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16) RETURNING id`,
		tid, req.Name, req.Organization, req.AgentType, req.ContactName, req.ContactEmail, req.ContactPhone,
		req.Region, req.Country, req.SectorFocus, req.RelationshipOwner, req.RiskLevel, req.PEPFlag, req.ConflictFlag,
		req.Notes, uid).Scan(&id); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

func (h *Agents) Get(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }
	row := h.db.QueryRow(c, `
		SELECT a.id, a.name, COALESCE(a.organization,''), a.agent_type,
		  COALESCE(a.contact_name,''), COALESCE(a.contact_email,''), COALESCE(a.contact_phone,''),
		  COALESCE(a.region,''), COALESCE(a.country,''), a.sector_focus,
		  a.relationship_owner, COALESCE(u.full_name,''), a.status, a.risk_level,
		  a.pep_flag, a.conflict_flag, COALESCE(a.notes,''), a.last_activity_at, a.created_at
		FROM agents a
		LEFT JOIN users u ON u.id = a.relationship_owner
		WHERE a.id=$1 AND a.tenant_id=$2 AND a.deleted_at IS NULL`, id, tid)
	var (
		aid, kind, status, risk, name, org, cn, ce, cp, region, country, notes, ownerName string
		sectors                                                                            []string
		ownerID                                                                            *uuid.UUID
		pep, conflict                                                                      bool
		lastAct                                                                            *time.Time
		created                                                                            time.Time
	)
	if err := row.Scan(&aid, &name, &org, &kind, &cn, &ce, &cp, &region, &country, &sectors,
		&ownerID, &ownerName, &status, &risk, &pep, &conflict, &notes, &lastAct, &created); err != nil {
		c.JSON(404, gin.H{"error": "agent not found"})
		return
	}
	docs := []gin.H{}
	drows, err := h.db.Query(c, `
		SELECT id, kind, name, object_key, uploaded_at FROM agent_documents
		WHERE agent_id=$1 ORDER BY uploaded_at DESC`, id)
	if err == nil {
		defer drows.Close()
		for drows.Next() {
			var did, dk, dn, dkey string
			var ts time.Time
			if err := drows.Scan(&did, &dk, &dn, &dkey, &ts); err == nil {
				docs = append(docs, gin.H{"id": did, "kind": dk, "name": dn, "object_key": dkey, "uploaded_at": ts})
			}
		}
	}
	have := map[string]bool{}
	for _, d := range docs {
		if k, ok := d["kind"].(string); ok { have[k] = true }
	}
	missing := []string{}
	for _, k := range AgentMandatoryDocs {
		if !have[k] { missing = append(missing, k) }
	}
	c.JSON(200, gin.H{
		"id": aid, "name": name, "organization": org, "agent_type": kind,
		"contact_name": cn, "contact_email": ce, "contact_phone": cp,
		"region": region, "country": country, "sector_focus": sectors,
		"relationship_owner_id": ownerID, "relationship_owner_name": ownerName,
		"status": status, "risk_level": risk,
		"pep_flag": pep, "conflict_flag": conflict, "notes": notes,
		"last_activity_at": lastAct, "created_at": created,
		"documents":         docs,
		"mandatory_kinds":   AgentMandatoryDocs,
		"mandatory_missing": missing,
		"can_engage":        len(missing) == 0,
		// Stubs — populated when engagement / introduction / commission tables go live.
		"engagements":       []any{},
		"introductions":     []any{},
		"commissions":       []any{},
		"performance":       gin.H{"introductions_count": 0, "meetings_count": 0, "active_relationships": 0},
	})
}

func (h *Agents) Update(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }
	var req struct {
		Name              *string    `json:"name"`
		Organization      *string    `json:"organization"`
		AgentType         *string    `json:"agent_type"`
		ContactName       *string    `json:"contact_name"`
		ContactEmail      *string    `json:"contact_email"`
		ContactPhone      *string    `json:"contact_phone"`
		Region            *string    `json:"region"`
		Country           *string    `json:"country"`
		SectorFocus       *[]string  `json:"sector_focus"`
		RelationshipOwner *uuid.UUID `json:"relationship_owner"`
		Status            *string    `json:"status"`
		RiskLevel         *string    `json:"risk_level"`
		PEPFlag           *bool      `json:"pep_flag"`
		ConflictFlag      *bool      `json:"conflict_flag"`
		Notes             *string    `json:"notes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }
	sets := []string{"updated_at=now()", "last_activity_at=now()"}
	args := []any{}
	add := func(col string, v any) { args = append(args, v); sets = append(sets, col+"=$"+strconv.Itoa(len(args))) }
	if req.Name != nil         { add("name", strings.TrimSpace(*req.Name)) }
	if req.Organization != nil { add("organization", *req.Organization) }
	if req.AgentType != nil    { add("agent_type", *req.AgentType) }
	if req.ContactName != nil  { add("contact_name", *req.ContactName) }
	if req.ContactEmail != nil { add("contact_email", *req.ContactEmail) }
	if req.ContactPhone != nil { add("contact_phone", *req.ContactPhone) }
	if req.Region != nil       { add("region", *req.Region) }
	if req.Country != nil      { add("country", *req.Country) }
	if req.SectorFocus != nil  { add("sector_focus", *req.SectorFocus) }
	if req.RelationshipOwner != nil { add("relationship_owner", *req.RelationshipOwner) }
	if req.Status != nil {
		valid := map[string]bool{"draft": true, "onboarded": true, "engaged": true, "suspended": true, "terminated": true}
		if !valid[*req.Status] { c.JSON(400, gin.H{"error": "invalid status"}); return }
		add("status", *req.Status)
	}
	if req.RiskLevel != nil {
		valid := map[string]bool{"low": true, "medium": true, "high": true, "critical": true}
		if !valid[*req.RiskLevel] { c.JSON(400, gin.H{"error": "invalid risk_level"}); return }
		add("risk_level", *req.RiskLevel)
	}
	if req.PEPFlag != nil      { add("pep_flag", *req.PEPFlag) }
	if req.ConflictFlag != nil { add("conflict_flag", *req.ConflictFlag) }
	if req.Notes != nil        { add("notes", *req.Notes) }
	if len(args) == 0 { c.JSON(400, gin.H{"error": "no changes"}); return }
	args = append(args, id, tid)
	q := "UPDATE agents SET " + strings.Join(sets, ", ") +
		" WHERE id=$" + strconv.Itoa(len(args)-1) + " AND tenant_id=$" + strconv.Itoa(len(args)) + " AND deleted_at IS NULL"
	if _, err := h.db.Exec(c, q, args...); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	c.JSON(200, gin.H{"ok": true})
}

func (h *Agents) Delete(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }
	if _, err := h.db.Exec(c,
		`UPDATE agents SET deleted_at=now() WHERE id=$1 AND tenant_id=$2`, id, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

/* ---------------- Documents ---------------- */

func (h *Agents) AddDocument(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }
	var req struct {
		Kind, Name, ObjectKey string `json:"kind"`
	}
	type body struct {
		Kind      string `json:"kind"`
		Name      string `json:"name"`
		ObjectKey string `json:"object_key"`
	}
	var b body
	if err := c.ShouldBindJSON(&b); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }
	req.Kind, req.Name, req.ObjectKey = b.Kind, b.Name, b.ObjectKey
	if req.Kind == "" || req.Name == "" || req.ObjectKey == "" {
		c.JSON(400, gin.H{"error": "kind, name and object_key required"})
		return
	}
	// Ownership check
	var owner uuid.UUID
	if err := h.db.QueryRow(c,
		`SELECT tenant_id FROM agents WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&owner); err != nil || owner != tid {
		c.JSON(404, gin.H{"error": "agent not found"})
		return
	}
	var docID uuid.UUID
	if err := h.db.QueryRow(c, `
		INSERT INTO agent_documents (agent_id, kind, name, object_key, uploaded_by)
		VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		id, req.Kind, req.Name, req.ObjectKey, uid).Scan(&docID); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	// Auto-promote draft → onboarded if the mandatory set is now complete.
	var docKinds []string
	_ = h.db.QueryRow(c, `SELECT array_agg(DISTINCT kind) FROM agent_documents WHERE agent_id=$1`, id).Scan(&docKinds)
	have := map[string]bool{}
	for _, k := range docKinds { have[k] = true }
	complete := true
	for _, k := range AgentMandatoryDocs {
		if !have[k] { complete = false; break }
	}
	if complete {
		_, _ = h.db.Exec(c, `UPDATE agents SET status='onboarded', updated_at=now() WHERE id=$1 AND status='draft'`, id)
	}
	_, _ = h.db.Exec(c, `UPDATE agents SET last_activity_at=now() WHERE id=$1`, id)
	c.JSON(201, gin.H{"id": docID})
}

func (h *Agents) DeleteDocument(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	docID, err := uuid.Parse(c.Param("docId"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }
	if _, err := h.db.Exec(c, `
		DELETE FROM agent_documents
		WHERE id=$1 AND agent_id IN (SELECT id FROM agents WHERE tenant_id=$2)`,
		docID, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

/* ---------------- Invitations (self-onboarding link) ---------------- */

func (h *Agents) CreateInvite(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }
	var req struct {
		Email   string `json:"email"`
		Message string `json:"message"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }
	req.Email = strings.TrimSpace(req.Email)
	if req.Email == "" { c.JSON(400, gin.H{"error": "email is required"}); return }

	var name string
	if err := h.db.QueryRow(c,
		`SELECT name FROM agents WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`,
		id, tid).Scan(&name); err != nil {
		c.JSON(404, gin.H{"error": "agent not found"})
		return
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	token := base64.RawURLEncoding.EncodeToString(buf)

	_, _ = h.db.Exec(c,
		`UPDATE agent_invitations SET revoked_at=now()
		 WHERE agent_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL`, id)
	expires := time.Now().Add(agentInviteTTL)
	if _, err := h.db.Exec(c, `
		INSERT INTO agent_invitations (tenant_id, agent_id, token, email, message, expires_at, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		tid, id, token, req.Email, req.Message, expires, uid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"token": token, "expires_at": expires, "agent": name, "email": req.Email})
}

func (h *Agents) ListInvites(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }
	rows, err := h.db.Query(c, `
		SELECT id, token, email, COALESCE(message,''), created_at, expires_at, accepted_at, revoked_at
		FROM agent_invitations WHERE agent_id=$1 AND tenant_id=$2
		ORDER BY created_at DESC LIMIT 20`, id, tid)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			invID                                                              uuid.UUID
			token, email, msg                                                  string
			created, expires                                                   time.Time
			accepted, revoked                                                  *time.Time
		)
		if err := rows.Scan(&invID, &token, &email, &msg, &created, &expires, &accepted, &revoked); err == nil {
			status := "pending"
			if revoked != nil { status = "revoked" } else if accepted != nil { status = "accepted" } else if time.Now().After(expires) { status = "expired" }
			out = append(out, gin.H{
				"id": invID, "token": token, "email": email, "message": msg,
				"created_at": created, "expires_at": expires,
				"accepted_at": accepted, "revoked_at": revoked, "status": status,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

func (h *Agents) RevokeInvite(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	invID, err := uuid.Parse(c.Param("inviteId"))
	if err != nil { c.JSON(400, gin.H{"error": "bad id"}); return }
	if _, err := h.db.Exec(c, `
		UPDATE agent_invitations SET revoked_at=now()
		WHERE id=$1 AND tenant_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL`,
		invID, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (h *Agents) PublicGetInvite(c *gin.Context) {
	token := c.Param("token")
	if token == "" { c.JSON(400, gin.H{"error": "missing token"}); return }
	var (
		aid                                                                 uuid.UUID
		email, msg, aname, atype, country, region                           string
		expires                                                             time.Time
		accepted, revoked                                                   *time.Time
	)
	err := h.db.QueryRow(c, `
		SELECT i.agent_id, i.email, COALESCE(i.message,''), i.expires_at, i.accepted_at, i.revoked_at,
		       a.name, a.agent_type, COALESCE(a.country,''), COALESCE(a.region,'')
		FROM agent_invitations i
		JOIN agents a ON a.id = i.agent_id
		WHERE i.token=$1`, token).Scan(
		&aid, &email, &msg, &expires, &accepted, &revoked,
		&aname, &atype, &country, &region,
	)
	if err != nil { c.JSON(404, gin.H{"error": "invitation not found"}); return }
	switch {
	case revoked != nil:
		c.JSON(410, gin.H{"error": "This invitation has been revoked.", "code": "revoked"}); return
	case accepted != nil:
		c.JSON(410, gin.H{"error": "This invitation has already been completed.", "code": "accepted"}); return
	case time.Now().After(expires):
		c.JSON(410, gin.H{"error": "This invitation has expired.", "code": "expired"}); return
	}
	c.JSON(200, gin.H{
		"agent_id":     aid,
		"agent_name":   aname,
		"agent_type":   atype,
		"country":      country,
		"region":       region,
		"invited_email": email,
		"message":      msg,
		"expires_at":   expires,
		"requested_fields": []string{
			"organization", "contact_name", "contact_email", "contact_phone",
			"region", "country", "sector_focus", "notes",
		},
		"required_documents": AgentMandatoryDocs,
	})
}

func (h *Agents) PublicAcceptInvite(c *gin.Context) {
	token := c.Param("token")
	if token == "" { c.JSON(400, gin.H{"error": "missing token"}); return }
	var req struct {
		Organization string   `json:"organization"`
		ContactName  string   `json:"contact_name"`
		ContactEmail string   `json:"contact_email"`
		ContactPhone string   `json:"contact_phone"`
		Region       string   `json:"region"`
		Country      string   `json:"country"`
		SectorFocus  []string `json:"sector_focus"`
		Notes        string   `json:"notes"`
		Documents    []struct {
			Kind, Name, ObjectKey string
		} `json:"documents"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }

	var (
		aid               uuid.UUID
		expires           time.Time
		accepted, revoked *time.Time
	)
	if err := h.db.QueryRow(c, `
		SELECT agent_id, expires_at, accepted_at, revoked_at
		FROM agent_invitations WHERE token=$1`, token).Scan(&aid, &expires, &accepted, &revoked); err != nil {
		c.JSON(404, gin.H{"error": "invitation not found"})
		return
	}
	switch {
	case revoked != nil:  c.JSON(410, gin.H{"error": "Invitation revoked.",  "code": "revoked"});  return
	case accepted != nil: c.JSON(410, gin.H{"error": "Invitation already used.", "code": "accepted"}); return
	case time.Now().After(expires): c.JSON(410, gin.H{"error": "Invitation expired.", "code": "expired"}); return
	}

	tx, err := h.db.Begin(c)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	defer tx.Rollback(c)

	sets := []string{"updated_at=now()", "last_activity_at=now()"}
	args := []any{}
	add := func(col string, v any) { args = append(args, v); sets = append(sets, col+"=$"+strconv.Itoa(len(args))) }
	if s := strings.TrimSpace(req.Organization); s != "" { add("organization", s) }
	if s := strings.TrimSpace(req.ContactName);  s != "" { add("contact_name", s) }
	if s := strings.TrimSpace(req.ContactEmail); s != "" { add("contact_email", s) }
	if s := strings.TrimSpace(req.ContactPhone); s != "" { add("contact_phone", s) }
	if s := strings.TrimSpace(req.Region);       s != "" { add("region", s) }
	if s := strings.TrimSpace(req.Country);      s != "" { add("country", s) }
	if s := strings.TrimSpace(req.Notes);        s != "" { add("notes", s) }
	if req.SectorFocus != nil { add("sector_focus", req.SectorFocus) }
	args = append(args, aid)
	if _, err := tx.Exec(c,
		"UPDATE agents SET "+strings.Join(sets, ", ")+" WHERE id=$"+strconv.Itoa(len(args)),
		args...); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	for _, d := range req.Documents {
		if d.Kind == "" || d.Name == "" || d.ObjectKey == "" { continue }
		if _, err := tx.Exec(c, `
			INSERT INTO agent_documents (agent_id, kind, name, object_key)
			VALUES ($1,$2,$3,$4)`, aid, d.Kind, d.Name, d.ObjectKey); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
	}

	var docKinds []string
	_ = tx.QueryRow(c, `SELECT array_agg(DISTINCT kind) FROM agent_documents WHERE agent_id=$1`, aid).Scan(&docKinds)
	have := map[string]bool{}
	for _, k := range docKinds { have[k] = true }
	complete := true
	for _, k := range AgentMandatoryDocs { if !have[k] { complete = false; break } }
	if complete {
		_, _ = tx.Exec(c, `UPDATE agents SET status='onboarded' WHERE id=$1 AND status='draft'`, aid)
	}
	if _, err := tx.Exec(c,
		`UPDATE agent_invitations SET accepted_at=now() WHERE token=$1`, token); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if err := tx.Commit(c); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	c.JSON(200, gin.H{"ok": true})
}
