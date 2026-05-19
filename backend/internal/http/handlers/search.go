// Global search — one tenant-scoped, permission-aware endpoint behind
// the command palette. Each entity is a small capped query; results
// are returned flat with a `type` the SPA groups on. Visibility rules
// mirror the per-module list endpoints so search never leaks a row a
// user couldn't open anyway.
package handlers

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/decapods/pgdp/backend/internal/auth"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
)

type Search struct{ db *pgxpool.Pool }

func NewSearch(db *pgxpool.Pool) *Search { return &Search{db: db} }

type searchHit struct {
	Type     string `json:"type"`
	ID       string `json:"id"`
	Title    string `json:"title"`
	Subtitle string `json:"subtitle"`
	URL      string `json:"url"`
}

// perCat caps each entity so a broad query stays one fast page.
const perCat = 6

func (h *Search) Search(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)

	q := strings.TrimSpace(c.Query("q"))
	if len([]rune(q)) < 2 {
		c.JSON(http.StatusOK, gin.H{"items": []searchHit{}})
		return
	}
	like := "%" + q + "%"
	ctx := c.Request.Context()
	out := []searchHit{}

	// ── People — the directory is broadly readable; everyone can find
	// a colleague. Active, non-deleted only.
	if rows, err := h.db.Query(ctx, `
		SELECT id, COALESCE(full_name,''), email::text, COALESCE(job_title,'')
		FROM users
		WHERE tenant_id=$1 AND deleted_at IS NULL AND status='active'
		  AND (full_name ILIKE $2 OR email::text ILIKE $2)
		ORDER BY full_name LIMIT $3`, tid, like, perCat); err == nil {
		for rows.Next() {
			var id uuid.UUID
			var name, email, jt string
			if rows.Scan(&id, &name, &email, &jt) == nil {
				sub := jt
				if sub == "" {
					sub = email
				}
				out = append(out, searchHit{"person", id.String(), nameOr(name, email), sub, "/colleagues?focus=" + id.String()})
			}
		}
		rows.Close()
	}

	// ── Projects — members see their own; project:read sees all.
	canAllProjects := auth.HasPermission(roles, "project:read")
	pq := `
		SELECT p.id, p.code, p.name, p.status
		FROM projects p
		WHERE p.tenant_id=$1 AND p.deleted_at IS NULL
		  AND (p.code ILIKE $2 OR p.name ILIKE $2)`
	pargs := []any{tid, like}
	if !canAllProjects {
		pq += ` AND EXISTS (SELECT 1 FROM project_members pm
		         WHERE pm.project_id=p.id AND pm.user_id=$3 AND pm.removed_at IS NULL)`
		pargs = append(pargs, uid)
	}
	pq += " ORDER BY p.updated_at DESC LIMIT " + strconv.Itoa(perCat)
	if rows, err := h.db.Query(ctx, pq, pargs...); err == nil {
		for rows.Next() {
			var id uuid.UUID
			var code, name, status string
			if rows.Scan(&id, &code, &name, &status) == nil {
				out = append(out, searchHit{"project", id.String(), name, code + " · " + cleanStatus(status), "/projects/" + id.String()})
			}
		}
		rows.Close()
	}

	// ── Opportunities — gated on opportunity:read.
	if auth.HasPermission(roles, "opportunity:read") {
		if rows, err := h.db.Query(ctx, `
			SELECT id, title, stage
			FROM opportunities
			WHERE tenant_id=$1 AND deleted_at IS NULL AND title ILIKE $2
			ORDER BY updated_at DESC LIMIT $3`, tid, like, perCat); err == nil {
			for rows.Next() {
				var id uuid.UUID
				var title, stage string
				if rows.Scan(&id, &title, &stage) == nil {
					out = append(out, searchHit{"opportunity", id.String(), title, cleanStatus(stage), "/pipeline/" + id.String()})
				}
			}
			rows.Close()
		}
	}

	// ── Tasks — only on projects the caller can see.
	tq := `
		SELECT t.id, t.title, p.code, p.id
		FROM tasks t
		JOIN projects p ON p.id = t.project_id
		WHERE p.tenant_id=$1 AND t.deleted_at IS NULL AND t.title ILIKE $2`
	targs := []any{tid, like}
	if !canAllProjects {
		tq += ` AND EXISTS (SELECT 1 FROM project_members pm
		         WHERE pm.project_id=p.id AND pm.user_id=$3 AND pm.removed_at IS NULL)`
		targs = append(targs, uid)
	}
	tq += " ORDER BY t.updated_at DESC LIMIT " + strconv.Itoa(perCat)
	if rows, err := h.db.Query(ctx, tq, targs...); err == nil {
		for rows.Next() {
			var id, pid uuid.UUID
			var title, code string
			if rows.Scan(&id, &title, &code, &pid) == nil {
				out = append(out, searchHit{"task", id.String(), title, code, "/projects/" + pid.String() + "/tasks/" + id.String()})
			}
		}
		rows.Close()
	}

	// ── Campfire posts — same audience predicate as ListPosts so a
	// team-scoped post never surfaces to someone outside the line.
	if rows, err := h.db.Query(ctx, `
		SELECT p.id, COALESCE(NULLIF(p.title,''), LEFT(p.body, 80)), COALESCE(u.full_name, u.email::text, 'Someone')
		FROM campfire_posts p
		LEFT JOIN users u ON u.id = p.author_id
		WHERE p.tenant_id=$1
		  AND (p.title ILIKE $2 OR p.body ILIKE $2)
		  AND (
		    p.audience = 'workspace'
		    OR p.author_id = $3
		    OR EXISTS (
		      SELECT 1 FROM users au WHERE au.id = p.author_id AND (
		        au.manager_id = $3
		        OR (SELECT vu.manager_id FROM users vu WHERE vu.id = $3) = au.id
		        OR (au.manager_id IS NOT NULL
		            AND au.manager_id = (SELECT vu.manager_id FROM users vu WHERE vu.id = $3))
		      )
		    )
		  )
		ORDER BY p.created_at DESC LIMIT $4`, tid, like, uid, perCat); err == nil {
		for rows.Next() {
			var id uuid.UUID
			var title, author string
			if rows.Scan(&id, &title, &author) == nil {
				out = append(out, searchHit{"post", id.String(), strings.TrimSpace(title), "Campfire · " + author, "/campfire?post=" + id.String()})
			}
		}
		rows.Close()
	}

	// ── Legals — gated on governance:read (same as the Legals page).
	if auth.HasPermission(roles, "governance:read") {
		if rows, err := h.db.Query(ctx, `
			SELECT id, title, category, COALESCE(party,'')
			FROM legal_documents
			WHERE tenant_id=$1
			  AND (title ILIKE $2 OR party ILIKE $2 OR reference_no ILIKE $2 OR category ILIKE $2)
			ORDER BY updated_at DESC LIMIT $3`, tid, like, perCat); err == nil {
			for rows.Next() {
				var id uuid.UUID
				var title, cat, party string
				if rows.Scan(&id, &title, &cat, &party) == nil {
					sub := cleanStatus(cat)
					if party != "" {
						sub += " · " + party
					}
					out = append(out, searchHit{"legal", id.String(), title, sub, "/legals?focus=" + id.String()})
				}
			}
			rows.Close()
		}
	}

	c.JSON(http.StatusOK, gin.H{"items": out})
}

func nameOr(name, email string) string {
	if strings.TrimSpace(name) != "" {
		return name
	}
	return email
}

func cleanStatus(s string) string {
	return strings.ReplaceAll(s, "_", " ")
}
