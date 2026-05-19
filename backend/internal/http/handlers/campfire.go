// Package handlers — campfire.go
//
// Campfire is the workspace's social layer: pulse feed, recognition, mood
// check-ins, help requests, team chat rooms, and a small admin insights panel.
// All endpoints are tenant-scoped, polling-friendly (no websockets yet), and
// share a polymorphic reaction model.
package handlers

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/decapods/pgdp/backend/internal/auth"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/notifications"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Campfire struct {
	db     *pgxpool.Pool
	notify *notifications.Engine

	previewMu    sync.RWMutex
	previewCache map[string]cachedPreview
}

type cachedPreview struct {
	at   time.Time
	data linkPreview
}

type linkPreview struct {
	URL         string `json:"url"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Image       string `json:"image"`
	Favicon     string `json:"favicon"`
	SiteName    string `json:"site_name"`
}

func NewCampfire(db *pgxpool.Pool) *Campfire {
	return &Campfire{db: db, previewCache: map[string]cachedPreview{}}
}

// WithEngine attaches the notifications engine so posts/comments/messages can
// dispatch @mention pings. Optional — Campfire still works without it.
func (h *Campfire) WithEngine(engine *notifications.Engine) *Campfire {
	h.notify = engine
	return h
}

// ──────────────────────────────────────────────────────────────────────────
// Realtime presence bar — derived from users.last_seen_at + manual_status.
// Reuses the same rules as me.go's derivePresence so the campfire and the
// top-bar badge never disagree about who's online.
// ──────────────────────────────────────────────────────────────────────────

func (h *Campfire) Presence(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)

	// Anyone with an approved leave overlapping today is "on leave" — that
	// state overrides whatever the heartbeat says.
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT u.id, COALESCE(u.full_name,''), u.email::text,
		       u.last_seen_at, u.manual_status, u.manual_status_until,
		       EXISTS (
		         SELECT 1 FROM leave_requests lr
		          WHERE lr.user_id = u.id
		            AND lr.status = 'approved'
		            AND CURRENT_DATE BETWEEN lr.start_date AND lr.end_date
		       ) AS on_leave
		FROM users u
		WHERE u.tenant_id=$1 AND u.deleted_at IS NULL AND u.status='active'
		ORDER BY u.full_name`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	buckets := map[string][]gin.H{
		"online": {}, "away": {}, "busy": {}, "on_leave": {}, "focus": {}, "offline": {},
	}
	for rows.Next() {
		var (
			id                          uuid.UUID
			name, email                 string
			lastSeen                    *time.Time
			manual                      *string
			manualUntil                 *time.Time
			onLeave                     bool
		)
		if err := rows.Scan(&id, &name, &email, &lastSeen, &manual, &manualUntil, &onLeave); err != nil {
			continue
		}
		bucket := classifyPresence(manual, manualUntil, lastSeen, onLeave)
		buckets[bucket] = append(buckets[bucket], gin.H{
			"id": id, "name": name, "email": email,
			"last_seen_at": lastSeen,
		})
	}
	c.JSON(200, gin.H{
		"online":   buckets["online"],
		"away":     buckets["away"],
		"busy":     buckets["busy"],
		"on_leave": buckets["on_leave"],
		"focus":    buckets["focus"],
		"offline":  buckets["offline"],
	})
}

// classifyPresence is a campfire-flavoured presence bucketer. Same rules as
// me.go but adds "on_leave" and "focus" buckets (focus = manual "busy"). Kept
// local to avoid a cyclic dep on the me handler.
func classifyPresence(manual *string, manualUntil *time.Time, lastSeen *time.Time, onLeave bool) string {
	if onLeave {
		return "on_leave"
	}
	if manual != nil && *manual != "" && (manualUntil == nil || manualUntil.After(time.Now())) {
		switch *manual {
		case "invisible":
			return "offline"
		case "busy":
			return "focus"
		case "away":
			return "away"
		case "online":
			return "online"
		}
	}
	if lastSeen == nil {
		return "offline"
	}
	// Windows match derivePresence in me.go so Campfire and the rest of the
	// app never disagree about who's "around". Generous on purpose — the
	// heartbeat fires every ~60s, so a 5-minute online window forgives a
	// quick tab-switch or a one-poll blip.
	since := time.Since(*lastSeen)
	switch {
	case since < 5*time.Minute:
		return "online"
	case since < 20*time.Minute:
		return "away"
	default:
		return "offline"
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Pulse feed — posts, comments, reactions, pinning
// ──────────────────────────────────────────────────────────────────────────

var validPostKinds = map[string]bool{
	"announcement": true, "win": true, "celebration": true, "joiner": true,
	"birthday": true, "anniversary": true, "note": true, "update": true,
	// Polls — meta carries the options + flags. The card renders inline
	// vote bars and a "Vote" button. Tallies live in campfire_poll_votes.
	"poll": true,
}

func (h *Campfire) ListPosts(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)

	limit := 50
	if v, _ := strconv.Atoi(c.Query("limit")); v > 0 && v <= 200 {
		limit = v
	}

	// Optional author filter — drives the "click a name → see their
	// Campfire timeline" Twitter-style profile view. When set we drop the
	// pinned-first ordering because the user wants a pure chronological
	// stream of one person, not the workspace's top posts.
	authorFilter := strings.TrimSpace(c.Query("author_id"))
	// $1=tenant, $2=limit, $3=viewer. The audience predicate uses $3
	// to decide whether a 'team'-scoped post is visible: a team post
	// is seen only by the author, the author's manager, the author's
	// direct reports, and peers under the same manager. 'workspace'
	// posts stay all-hands.
	args := []any{tid, limit, uid}
	q := `
		SELECT p.id, p.author_id, COALESCE(u.full_name,''), COALESCE(u.email::text,''),
		       COALESCE(u.avatar_url,''),
		       p.kind, COALESCE(p.title,''), p.body, p.meta, p.pinned, p.created_at, p.edited_at,
		       p.audience,
		       (SELECT COUNT(*) FROM campfire_comments cc WHERE cc.post_id=p.id) AS comment_count
		FROM campfire_posts p
		LEFT JOIN users u ON u.id = p.author_id
		WHERE p.tenant_id=$1
		  AND (
		    p.audience = 'workspace'
		    OR p.author_id = $3
		    OR EXISTS (
		      SELECT 1 FROM users au
		      WHERE au.id = p.author_id
		        AND (
		          au.manager_id = $3
		          OR (SELECT vu.manager_id FROM users vu WHERE vu.id = $3) = au.id
		          OR (au.manager_id IS NOT NULL
		              AND au.manager_id = (SELECT vu.manager_id FROM users vu WHERE vu.id = $3))
		        )
		    )
		  )`
	if authorFilter != "" {
		args = append(args, authorFilter)
		q += " AND p.author_id = $" + strconv.Itoa(len(args)) + "::uuid"
		q += " ORDER BY p.created_at DESC LIMIT $2"
	} else {
		q += " ORDER BY p.pinned DESC, p.created_at DESC LIMIT $2"
	}
	rows, err := h.db.Query(c.Request.Context(), q, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	posts := []gin.H{}
	postIDs := []uuid.UUID{}
	for rows.Next() {
		var (
			id                                       uuid.UUID
			authorID                                 *uuid.UUID
			authorName, authorEmail, authorAvatar    string
			kind, title, body                        string
			meta                                     map[string]any
			pinned                                   bool
			created                                  time.Time
			edited                                   *time.Time
			audience                                 string
			// Postgres COUNT(*) is bigint; see the long note in ListRooms.
			// Plain int silently drops the row on some pgx setups.
			commentCount                             int64
		)
		if err := rows.Scan(&id, &authorID, &authorName, &authorEmail, &authorAvatar, &kind,
			&title, &body, &meta, &pinned, &created, &edited, &audience, &commentCount); err == nil {
			posts = append(posts, gin.H{
				"id": id, "author_id": authorID, "author_name": authorName, "author_email": authorEmail,
				"author_avatar_url": authorAvatar,
				"kind": kind, "title": title, "body": body, "meta": meta,
				"pinned": pinned, "created_at": created, "edited_at": edited,
				"audience": audience,
				"comment_count": commentCount,
			})
			postIDs = append(postIDs, id)
		}
	}

	// Hydrate reactions in one round trip. Each post gets a {emoji: count, ...}
	// map plus the set of emoji the requester has reacted with (so the UI can
	// render the toggle state correctly).
	reactions := loadReactions(c.Request.Context(), h.db, "post", postIDs, uid)
	for _, p := range posts {
		id := p["id"].(uuid.UUID)
		p["reactions"] = reactions[id]
	}

	// Hydrate poll tallies. One query for the whole page: count votes per
	// (post, option) plus the calling user's selections. Posts without any
	// votes still render the bars at 0, so the result map needs an empty
	// entry for every poll post even when nobody has voted yet.
	pollIDs := []uuid.UUID{}
	for _, p := range posts {
		if p["kind"] == "poll" {
			pollIDs = append(pollIDs, p["id"].(uuid.UUID))
		}
	}
	if len(pollIDs) > 0 {
		tallies := map[uuid.UUID]map[int]int64{}
		myVotes := map[uuid.UUID]map[int]bool{}
		voters := map[uuid.UUID]map[uuid.UUID]bool{}
		rows2, err := h.db.Query(c.Request.Context(), `
			SELECT post_id, option_idx, user_id
			FROM campfire_poll_votes WHERE post_id = ANY($1)`, pollIDs)
		if err == nil {
			defer rows2.Close()
			for rows2.Next() {
				var pid, vUID uuid.UUID
				var idx int
				if err := rows2.Scan(&pid, &idx, &vUID); err == nil {
					if tallies[pid] == nil {
						tallies[pid] = map[int]int64{}
					}
					tallies[pid][idx]++
					if vUID == uid {
						if myVotes[pid] == nil {
							myVotes[pid] = map[int]bool{}
						}
						myVotes[pid][idx] = true
					}
					if voters[pid] == nil {
						voters[pid] = map[uuid.UUID]bool{}
					}
					voters[pid][vUID] = true
				}
			}
		}
		for _, p := range posts {
			if p["kind"] != "poll" {
				continue
			}
			id := p["id"].(uuid.UUID)
			t := tallies[id]
			counts := []int64{}
			meta, _ := p["meta"].(map[string]any)
			if opts, ok := meta["options"].([]any); ok {
				counts = make([]int64, len(opts))
				for i := range opts {
					counts[i] = t[i]
				}
			}
			mine := []int{}
			for idx := range myVotes[id] {
				mine = append(mine, idx)
			}
			meta["vote_counts"] = counts
			meta["my_votes"] = mine
			meta["voter_count"] = int64(len(voters[id]))
			p["meta"] = meta
		}
	}

	// Read-receipt hydration. One round trip for the page: per-post
	// reader count + whether the caller has seen it. The UI only shows
	// this for announcement-kind posts, but hydrating all of them keeps
	// the query simple and the payload is two small ints per post.
	if len(postIDs) > 0 {
		seenCount := map[uuid.UUID]int64{}
		mySeen := map[uuid.UUID]bool{}
		rrows, err := h.db.Query(c.Request.Context(), `
			SELECT post_id, COUNT(*)::bigint,
			       BOOL_OR(user_id = $2) AS mine
			FROM campfire_post_reads
			WHERE post_id = ANY($1)
			GROUP BY post_id`, postIDs, uid)
		if err == nil {
			defer rrows.Close()
			for rrows.Next() {
				var pid uuid.UUID
				var n int64
				var mine bool
				if err := rrows.Scan(&pid, &n, &mine); err == nil {
					seenCount[pid] = n
					mySeen[pid] = mine
				}
			}
		}
		// Denominator for workspace announcements: active members in
		// the tenant. Team-scoped posts don't get a denominator (the
		// audience set is dynamic) — the UI just shows the raw count.
		var activeMembers int64
		_ = h.db.QueryRow(c.Request.Context(),
			`SELECT COUNT(*)::bigint FROM users
			 WHERE tenant_id=$1 AND deleted_at IS NULL AND status='active'`,
			tid).Scan(&activeMembers)
		for _, p := range posts {
			id := p["id"].(uuid.UUID)
			p["seen_count"] = seenCount[id]
			p["seen_by_me"] = mySeen[id]
			if p["audience"] == "workspace" {
				p["audience_size"] = activeMembers
			}
		}
	}

	c.JSON(200, gin.H{"items": posts})
}

// MarkPostRead records that the caller has seen a post. Idempotent
// (PK upsert) so the SPA can fire it freely on render. Only the
// announcement card actually calls it today, but the endpoint is
// kind-agnostic.
func (h *Campfire) MarkPostRead(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	postID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	// Confirm the post exists in this tenant before writing a receipt
	// so a guessed id can't seed rows for another workspace's post.
	var exists bool
	if err := h.db.QueryRow(c.Request.Context(),
		`SELECT EXISTS(SELECT 1 FROM campfire_posts WHERE id=$1 AND tenant_id=$2)`,
		postID, tid).Scan(&exists); err != nil || !exists {
		c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		return
	}
	if _, err := h.db.Exec(c.Request.Context(), `
		INSERT INTO campfire_post_reads (post_id, user_id)
		VALUES ($1,$2)
		ON CONFLICT (post_id, user_id) DO NOTHING`,
		postID, uid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// PostReaders returns the people who have seen a post, newest first.
// Used by the "Seen by N" chip's hover/expand on announcements.
func (h *Campfire) PostReaders(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	postID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT u.id, COALESCE(u.full_name,''), u.email::text,
		       COALESCE(u.avatar_url,''), r.seen_at
		FROM campfire_post_reads r
		JOIN users u ON u.id = r.user_id
		JOIN campfire_posts p ON p.id = r.post_id
		WHERE r.post_id=$1 AND p.tenant_id=$2 AND u.deleted_at IS NULL
		ORDER BY r.seen_at DESC
		LIMIT 200`, postID, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id uuid.UUID
		var name, email, avatar string
		var seenAt time.Time
		if err := rows.Scan(&id, &name, &email, &avatar, &seenAt); err == nil {
			out = append(out, gin.H{
				"id": id, "name": name, "email": email,
				"avatar_url": avatar, "seen_at": seenAt,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

// VotePoll toggles the caller's vote on a poll option. The body specifies
// option_idx; the handler enforces uniqueness per (post, user, idx) so
// re-clicking the same option un-votes. For single-choice polls (meta.multi
// is missing or false), voting for a new option clears the previous one.
func (h *Campfire) VotePoll(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	postID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad post id"})
		return
	}
	var req struct {
		OptionIdx int `json:"option_idx"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	// Fetch the post + its meta to know option count + single-vs-multi.
	var (
		kind string
		meta map[string]any
	)
	if err := h.db.QueryRow(c.Request.Context(), `
		SELECT kind, COALESCE(meta, '{}'::jsonb) FROM campfire_posts
		WHERE id=$1 AND tenant_id=$2`, postID, tid).Scan(&kind, &meta); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "poll not found"})
		return
	}
	if kind != "poll" {
		c.JSON(400, gin.H{"error": "not a poll"})
		return
	}
	opts, _ := meta["options"].([]any)
	if req.OptionIdx < 0 || req.OptionIdx >= len(opts) {
		c.JSON(400, gin.H{"error": "option_idx out of range"})
		return
	}
	multi, _ := meta["multi"].(bool)

	tx, err := h.db.Begin(c.Request.Context())
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(c.Request.Context())

	// Look for an existing vote on this exact option. If we find one, the
	// click is a toggle-off: remove it. Otherwise, for single-vote polls
	// clear all the caller's previous votes first; then insert.
	var has bool
	if err := tx.QueryRow(c.Request.Context(), `
		SELECT EXISTS (SELECT 1 FROM campfire_poll_votes
		               WHERE post_id=$1 AND user_id=$2 AND option_idx=$3)`,
		postID, uid, req.OptionIdx).Scan(&has); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if has {
		if _, err := tx.Exec(c.Request.Context(), `
			DELETE FROM campfire_poll_votes
			WHERE post_id=$1 AND user_id=$2 AND option_idx=$3`,
			postID, uid, req.OptionIdx); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
	} else {
		if !multi {
			if _, err := tx.Exec(c.Request.Context(), `
				DELETE FROM campfire_poll_votes
				WHERE post_id=$1 AND user_id=$2`, postID, uid); err != nil {
				c.JSON(500, gin.H{"error": err.Error()})
				return
			}
		}
		if _, err := tx.Exec(c.Request.Context(), `
			INSERT INTO campfire_poll_votes (post_id, user_id, option_idx)
			VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
			postID, uid, req.OptionIdx); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
	}
	if err := tx.Commit(c.Request.Context()); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (h *Campfire) CreatePost(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Kind     string         `json:"kind"   binding:"required"`
		Title    string         `json:"title"`
		Body     string         `json:"body"   binding:"required,min=1"`
		Meta     map[string]any `json:"meta"`
		Pinned   bool           `json:"pinned"`
		Audience string         `json:"audience"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if !validPostKinds[req.Kind] {
		c.JSON(400, gin.H{"error": "invalid kind"})
		return
	}
	// Audience defaults to all-hands. Only 'team' narrows it. An
	// invalid value is rejected rather than silently widened so a
	// client bug can't leak a meant-to-be-scoped post workspace-wide.
	audience := strings.TrimSpace(req.Audience)
	if audience == "" {
		audience = "workspace"
	}
	if audience != "workspace" && audience != "team" {
		c.JSON(400, gin.H{"error": "invalid audience"})
		return
	}
	if req.Meta == nil {
		req.Meta = map[string]any{}
	}
	var id uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		INSERT INTO campfire_posts (tenant_id, author_id, kind, title, body, meta, pinned, audience)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8) RETURNING id`,
		tid, uid, req.Kind, strings.TrimSpace(req.Title), strings.TrimSpace(req.Body),
		req.Meta, req.Pinned, audience).Scan(&id); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Fan out @mention pings — author's body is the source of truth.
	// Link carries the post ID so the SPA can scroll the recipient
	// straight to the mention rather than dumping them at the Campfire
	// index.
	go h.dispatchMentions(context.Background(), tid, uid, req.Body, "Campfire post", "/campfire?post="+id.String())

	c.JSON(201, gin.H{"id": id})
}

// UpdatePost lets the author edit their own post body (and title for kinds
// that use one). Admins with governance:write can edit anyone's — useful for
// cleaning up content. Anyone else gets 403. Mirrors UpdateComment's access
// rule so the SPA can use the same pattern.
func (h *Campfire) UpdatePost(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	postID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct {
		Title *string `json:"title"`
		Body  *string `json:"body"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if req.Body == nil && req.Title == nil {
		c.JSON(400, gin.H{"error": "nothing to update"})
		return
	}
	if req.Body != nil && strings.TrimSpace(*req.Body) == "" {
		c.JSON(400, gin.H{"error": "body cannot be empty"})
		return
	}
	var authorID uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(),
		`SELECT author_id FROM campfire_posts WHERE id=$1 AND tenant_id=$2`,
		postID, tid).Scan(&authorID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		return
	}
	// Author-only by policy. Admins do not get an override — moderating
	// someone else's voice is not a Campfire affordance today. If a
	// post has to come down, the author removes it (or, as a last
	// resort, a DB-level intervention with a paper trail).
	_ = roles
	if authorID != uid {
		c.JSON(http.StatusForbidden, gin.H{"error": "you can only edit your own posts"})
		return
	}
	// Build the patch dynamically — title is independent of body so we can
	// rename a post without forcing the body field on the API surface.
	sets := []string{"edited_at = now()"}
	args := []any{}
	add := func(col string, v any) { args = append(args, v); sets = append(sets, col+"=$"+strconv.Itoa(len(args))) }
	if req.Body != nil {
		add("body", strings.TrimSpace(*req.Body))
	}
	if req.Title != nil {
		add("title", strings.TrimSpace(*req.Title))
	}
	args = append(args, postID, tid)
	q := "UPDATE campfire_posts SET " + strings.Join(sets, ", ") +
		" WHERE id=$" + strconv.Itoa(len(args)-1) + " AND tenant_id=$" + strconv.Itoa(len(args))
	if _, err := h.db.Exec(c.Request.Context(), q, args...); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	// Re-dispatch @mentions on edits — if the author adds a new @handle,
	// that person should still get pinged. dispatchMentions has its own
	// dedupe so previously-mentioned people won't be re-notified.
	if req.Body != nil {
		go h.dispatchMentions(context.Background(), tid, uid, *req.Body, "Campfire post", "/campfire?post="+postID.String())
	}
	c.JSON(200, gin.H{"ok": true})
}

func (h *Campfire) PinPost(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct{ Pinned bool `json:"pinned"` }
	_ = c.ShouldBindJSON(&req)
	if _, err := h.db.Exec(c.Request.Context(),
		`UPDATE campfire_posts SET pinned=$1 WHERE id=$2 AND tenant_id=$3`,
		req.Pinned, id, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (h *Campfire) DeletePost(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	// Author-only: confirm the caller authored the post before we
	// touch the row. The route used to assume an upstream guard
	// existed but no permission gate is attached, so without this
	// check any authenticated user could delete any post in the
	// tenant.
	var authorID uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(),
		`SELECT author_id FROM campfire_posts WHERE id=$1 AND tenant_id=$2`,
		id, tid,
	).Scan(&authorID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		return
	}
	if authorID != uid {
		c.JSON(http.StatusForbidden, gin.H{"error": "you can only delete your own posts"})
		return
	}
	if _, err := h.db.Exec(c.Request.Context(),
		`DELETE FROM campfire_posts WHERE id=$1 AND tenant_id=$2`, id, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// Comments —

func (h *Campfire) ListComments(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	postID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT c.id, c.author_id, COALESCE(u.full_name,''), COALESCE(u.email::text,''),
		       COALESCE(u.avatar_url,''),
		       c.body, c.created_at, c.edited_at
		FROM campfire_comments c
		LEFT JOIN users u ON u.id = c.author_id
		WHERE c.tenant_id=$1 AND c.post_id=$2
		ORDER BY c.created_at`, tid, postID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	ids := []uuid.UUID{}
	for rows.Next() {
		var (
			id                          uuid.UUID
			author                      *uuid.UUID
			name, email, avatar, body   string
			created                     time.Time
			edited                      *time.Time
		)
		if err := rows.Scan(&id, &author, &name, &email, &avatar, &body, &created, &edited); err == nil {
			out = append(out, gin.H{
				"id": id, "author_id": author, "author_name": name, "author_email": email,
				"author_avatar_url": avatar,
				"body": body, "created_at": created, "edited_at": edited,
			})
			ids = append(ids, id)
		}
	}
	reactions := loadReactions(c.Request.Context(), h.db, "comment", ids, uid)
	for _, cm := range out {
		cm["reactions"] = reactions[cm["id"].(uuid.UUID)]
	}
	c.JSON(200, gin.H{"items": out})
}

func (h *Campfire) AddComment(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	postID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct{ Body string `json:"body" binding:"required,min=1"` }
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	var id uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		INSERT INTO campfire_comments (tenant_id, post_id, author_id, body)
		VALUES ($1,$2,$3,$4) RETURNING id`,
		tid, postID, uid, strings.TrimSpace(req.Body)).Scan(&id); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	// Deep-link the recipient to the parent post (and the new comment
	// inside it). The SPA reads both query params on mount, scrolls
	// the post into view, auto-expands its comment thread, and
	// highlights the matching comment.
	deepLink := "/campfire?post=" + postID.String() + "&comment=" + id.String()
	go h.dispatchMentions(context.Background(), tid, uid, req.Body, "Campfire comment", deepLink)
	go h.notifyCommentReceived(context.Background(), tid, uid, postID, req.Body)
	c.JSON(201, gin.H{"id": id})
}

// notifyCommentReceived pings the post author (and anyone else who has
// already commented on the thread) when a new comment lands. Skips the
// caller — you don't need a ping for your own activity. Mention-based
// pings have already fired via dispatchMentions; we exclude any user the
// new body @mentions so they don't get two notifications about the same
// comment.
func (h *Campfire) notifyCommentReceived(ctx context.Context, tid, authorID, postID uuid.UUID, body string) {
	if h.notify == nil || h.db == nil {
		return
	}
	var postAuthorID uuid.UUID
	if err := h.db.QueryRow(ctx, `SELECT author_id FROM campfire_posts WHERE id=$1 AND tenant_id=$2`, postID, tid).Scan(&postAuthorID); err != nil {
		return
	}
	// Build the recipient set: post author + earlier commenters, minus the
	// caller. De-duped by user_id.
	wanted := map[uuid.UUID]bool{}
	if postAuthorID != authorID {
		wanted[postAuthorID] = true
	}
	rows, err := h.db.Query(ctx, `
		SELECT DISTINCT author_id FROM campfire_comments
		WHERE tenant_id=$1 AND post_id=$2 AND author_id <> $3`, tid, postID, authorID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err == nil {
				wanted[id] = true
			}
		}
	}
	if len(wanted) == 0 {
		return
	}
	var authorName string
	_ = h.db.QueryRow(ctx,
		`SELECT COALESCE(NULLIF(full_name,''), email::text) FROM users WHERE id=$1`, authorID,
	).Scan(&authorName)
	recipients := make([]notifications.Recipient, 0, len(wanted))
	for id := range wanted {
		id := id
		recipients = append(recipients, notifications.Recipient{UserID: &id})
	}
	h.notify.Notify(ctx, notifications.Event{
		Kind:       "campfire.comment_received",
		TenantID:   tid,
		Recipients: recipients,
		Payload: map[string]any{
			"Author": authorName,
			"Body":   truncate(body, 240),
		},
		DedupeKey: "campfire.comment:" + postID.String() + ":" + authorID.String(),
		Link:      "/campfire?post=" + postID.String(),
	})
}

// UpdateComment lets the author edit their own comment body. Admins
// (governance:write) can edit anyone's — useful for cleaning up profanity
// or correcting a typo on someone's behalf. Anyone else gets 403.
func (h *Campfire) UpdateComment(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	commentID, err := uuid.Parse(c.Param("commentID"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct {
		Body string `json:"body" binding:"required,min=1"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	var authorID uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		SELECT author_id FROM campfire_comments WHERE id=$1 AND tenant_id=$2`,
		commentID, tid).Scan(&authorID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found"})
		return
	}
	_ = roles
	if authorID != uid {
		c.JSON(http.StatusForbidden, gin.H{"error": "you can only edit your own comments"})
		return
	}
	body := strings.TrimSpace(req.Body)
	if _, err := h.db.Exec(c.Request.Context(), `
		UPDATE campfire_comments SET body=$1, edited_at=now() WHERE id=$2 AND tenant_id=$3`,
		body, commentID, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// DeleteComment — same access rule as UpdateComment: author or admin.
// Reactions on the comment cascade via FK; @mentions already fired at
// post time so we don't reverse those.
func (h *Campfire) DeleteComment(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	commentID, err := uuid.Parse(c.Param("commentID"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var authorID uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		SELECT author_id FROM campfire_comments WHERE id=$1 AND tenant_id=$2`,
		commentID, tid).Scan(&authorID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found"})
		return
	}
	_ = roles
	if authorID != uid {
		c.JSON(http.StatusForbidden, gin.H{"error": "you can only delete your own comments"})
		return
	}
	if _, err := h.db.Exec(c.Request.Context(), `
		DELETE FROM campfire_comments WHERE id=$1 AND tenant_id=$2`,
		commentID, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// Reactions — polymorphic toggle. POST adds if missing, removes if present
// (same emoji from same user). Caller specifies target via the URL.

func (h *Campfire) ToggleReaction(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	targetType := c.Param("kind") // post|comment|message|kudo
	targetID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct{ Emoji string `json:"emoji" binding:"required,min=1"` }
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	switch targetType {
	case "post", "comment", "message", "kudo":
	default:
		c.JSON(400, gin.H{"error": "bad target type"})
		return
	}

	// Try insert; on conflict, delete (toggle off).
	tag, err := h.db.Exec(c.Request.Context(), `
		INSERT INTO campfire_reactions (tenant_id, target_type, target_id, user_id, emoji)
		VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
		tid, targetType, targetID, uid, req.Emoji)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	added := tag.RowsAffected() == 1
	if !added {
		if _, err := h.db.Exec(c.Request.Context(), `
			DELETE FROM campfire_reactions
			WHERE target_type=$1 AND target_id=$2 AND user_id=$3 AND emoji=$4`,
			targetType, targetID, uid, req.Emoji); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
	}
	if added {
		go h.notifyReactionReceived(context.Background(), tid, uid, targetType, targetID, req.Emoji)
	}
	c.JSON(200, gin.H{"added": added})
}

// notifyReactionReceived pings the author of the post/comment/kudo/message
// that just got a reaction. Tier is Daily-digest in the catalog so a
// flurry of reactions doesn't spam the user — they'll see "🎉 ❤️ 👍 from
// 3 people on your post" in the daily roll-up.
func (h *Campfire) notifyReactionReceived(ctx context.Context, tid, reactorID uuid.UUID, targetType string, targetID uuid.UUID, emoji string) {
	if h.notify == nil || h.db == nil {
		return
	}
	var (
		authorID uuid.UUID
		where    string
	)
	switch targetType {
	case "post":
		_ = h.db.QueryRow(ctx, `SELECT author_id FROM campfire_posts WHERE id=$1 AND tenant_id=$2`, targetID, tid).Scan(&authorID)
		where = "post"
	case "comment":
		_ = h.db.QueryRow(ctx, `SELECT author_id FROM campfire_comments WHERE id=$1 AND tenant_id=$2`, targetID, tid).Scan(&authorID)
		where = "comment"
	case "kudo":
		_ = h.db.QueryRow(ctx, `SELECT to_user_id FROM campfire_kudos WHERE id=$1 AND tenant_id=$2`, targetID, tid).Scan(&authorID)
		where = "kudos"
	case "message":
		_ = h.db.QueryRow(ctx, `SELECT author_id FROM campfire_messages WHERE id=$1 AND tenant_id=$2`, targetID, tid).Scan(&authorID)
		where = "message"
	}
	if authorID == uuid.Nil || authorID == reactorID {
		return
	}
	var reactorName string
	_ = h.db.QueryRow(ctx,
		`SELECT COALESCE(NULLIF(full_name,''), email::text) FROM users WHERE id=$1`, reactorID,
	).Scan(&reactorName)
	h.notify.Notify(ctx, notifications.Event{
		Kind:       "campfire.reaction_received",
		TenantID:   tid,
		Recipients: []notifications.Recipient{{UserID: &authorID}},
		Payload: map[string]any{
			"Author": reactorName,
			"Emoji":  emoji,
			"Where":  where,
		},
		// Collapse rapid-fire reactions from the same person on the same
		// target into one notification.
		DedupeKey: "campfire.reaction:" + targetType + ":" + targetID.String() + ":" + reactorID.String(),
		Link:      "/campfire",
	})
}

type reactionSummary struct {
	Emoji string   `json:"emoji"`
	Count int      `json:"count"`
	Mine  bool     `json:"mine"`
	// Names of people who reacted with this emoji, oldest-first. We cap
	// the array at 10 in the SQL to keep payloads sane on extremely
	// popular reactions; the count above is the canonical truth.
	Users []string `json:"users"`
}

// loadReactions returns a map of target_id → []reactionSummary for the given
// IDs. Returns an empty map if ids is empty. The summary now includes the
// names of the reactors (up to 10) so the SPA can render the "who reacted"
// tooltip without a second round-trip.
func loadReactions(ctx context.Context, db *pgxpool.Pool, targetType string, ids []uuid.UUID, userID uuid.UUID) map[uuid.UUID][]reactionSummary {
	out := map[uuid.UUID][]reactionSummary{}
	if len(ids) == 0 {
		return out
	}
	rows, err := db.Query(ctx, `
		WITH grouped AS (
		  SELECT cr.target_id, cr.emoji,
		         COUNT(*)::int AS cnt,
		         BOOL_OR(cr.user_id = $1) AS mine,
		         array_agg(
		           COALESCE(NULLIF(u.full_name,''), u.email::text, '')
		           ORDER BY cr.created_at
		         ) FILTER (WHERE u.id IS NOT NULL) AS reactors
		    FROM campfire_reactions cr
		    LEFT JOIN users u ON u.id = cr.user_id
		   WHERE cr.target_type=$2 AND cr.target_id = ANY($3)
		   GROUP BY cr.target_id, cr.emoji
		)
		SELECT target_id, emoji, cnt, mine,
		       COALESCE(reactors[1:10], '{}')
		  FROM grouped
		 ORDER BY target_id, emoji`,
		userID, targetType, ids)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var tid uuid.UUID
		var r reactionSummary
		var reactors []string
		if err := rows.Scan(&tid, &r.Emoji, &r.Count, &r.Mine, &reactors); err == nil {
			r.Users = reactors
			if r.Users == nil {
				r.Users = []string{}
			}
			out[tid] = append(out[tid], r)
		}
	}
	return out
}

// ──────────────────────────────────────────────────────────────────────────
// Kudos / recognition
// ──────────────────────────────────────────────────────────────────────────

var validBadges = map[string]bool{
	"delivery_champion": true, "problem_solver": true, "team_player": true,
	"fast_responder": true, "client_hero": true, "custom": true,
}

func (h *Campfire) ListKudos(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	limit := 50
	if v, _ := strconv.Atoi(c.Query("limit")); v > 0 && v <= 200 {
		limit = v
	}
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT k.id, k.from_user_id, COALESCE(uf.full_name,''), COALESCE(uf.email::text,''),
		       k.to_user_id,   COALESCE(ut.full_name,''), COALESCE(ut.email::text,''),
		       k.badge, COALESCE(k.message,''), k.created_at
		FROM campfire_kudos k
		LEFT JOIN users uf ON uf.id = k.from_user_id
		LEFT JOIN users ut ON ut.id = k.to_user_id
		WHERE k.tenant_id=$1
		ORDER BY k.created_at DESC
		LIMIT $2`, tid, limit)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	ids := []uuid.UUID{}
	for rows.Next() {
		var (
			id, fromID, toID                       uuid.UUID
			fromName, fromEmail, toName, toEmail   string
			badge, message                         string
			created                                time.Time
		)
		if err := rows.Scan(&id, &fromID, &fromName, &fromEmail,
			&toID, &toName, &toEmail, &badge, &message, &created); err == nil {
			out = append(out, gin.H{
				"id": id,
				"from": gin.H{"id": fromID, "name": fromName, "email": fromEmail},
				"to":   gin.H{"id": toID, "name": toName, "email": toEmail},
				"badge": badge, "message": message, "created_at": created,
			})
			ids = append(ids, id)
		}
	}
	reactions := loadReactions(c.Request.Context(), h.db, "kudo", ids, uid)
	for _, k := range out {
		k["reactions"] = reactions[k["id"].(uuid.UUID)]
	}
	c.JSON(200, gin.H{"items": out})
}

func (h *Campfire) GiveKudo(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		ToUserID string `json:"to_user_id" binding:"required,uuid"`
		Badge    string `json:"badge"      binding:"required"`
		Message  string `json:"message"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if !validBadges[req.Badge] {
		c.JSON(400, gin.H{"error": "invalid badge"})
		return
	}
	to, _ := uuid.Parse(req.ToUserID)
	if to == uid {
		c.JSON(400, gin.H{"error": "Can't kudo yourself — recognition is for others.", "code": "self_kudo"})
		return
	}
	var id uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		INSERT INTO campfire_kudos (tenant_id, from_user_id, to_user_id, badge, message)
		VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		tid, uid, to, req.Badge, strings.TrimSpace(req.Message)).Scan(&id); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	go h.notifyKudosReceived(context.Background(), tid, uid, to, req.Badge, req.Message)
	c.JSON(201, gin.H{"id": id})
}

func (h *Campfire) notifyKudosReceived(ctx context.Context, tid, fromUserID, toUserID uuid.UUID, badge, message string) {
	if h.notify == nil || h.db == nil {
		return
	}
	var fromName string
	_ = h.db.QueryRow(ctx,
		`SELECT COALESCE(NULLIF(full_name,''), email::text) FROM users WHERE id=$1`, fromUserID,
	).Scan(&fromName)
	h.notify.Notify(ctx, notifications.Event{
		Kind:       "campfire.kudos_received",
		TenantID:   tid,
		Recipients: []notifications.Recipient{{UserID: &toUserID}},
		Payload: map[string]any{
			"Author": fromName,
			"Badge":  badge,
			"Body":   truncate(message, 240),
		},
		Link: "/campfire",
	})
}

// ──────────────────────────────────────────────────────────────────────────
// Mood / pulse check (one per user per day)
// ──────────────────────────────────────────────────────────────────────────

var validMoods = map[string]bool{"great": true, "good": true, "neutral": true, "stressed": true, "overloaded": true}

func (h *Campfire) MyMoodToday(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var (
		mood, note string
	)
	err := h.db.QueryRow(c.Request.Context(), `
		SELECT mood, COALESCE(note,'') FROM campfire_mood
		WHERE tenant_id=$1 AND user_id=$2 AND day=CURRENT_DATE`,
		tid, uid).Scan(&mood, &note)
	if err != nil {
		c.JSON(200, gin.H{"mood": nil})
		return
	}
	c.JSON(200, gin.H{"mood": mood, "note": note})
}

func (h *Campfire) SetMyMood(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Mood string `json:"mood" binding:"required"`
		Note string `json:"note"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if !validMoods[req.Mood] {
		c.JSON(400, gin.H{"error": "invalid mood"})
		return
	}
	if _, err := h.db.Exec(c.Request.Context(), `
		INSERT INTO campfire_mood (tenant_id, user_id, day, mood, note)
		VALUES ($1,$2,CURRENT_DATE,$3,NULLIF($4,''))
		ON CONFLICT (user_id, day) DO UPDATE SET mood=EXCLUDED.mood, note=EXCLUDED.note`,
		tid, uid, req.Mood, strings.TrimSpace(req.Note)); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// MoodTrend returns the last N days of tenant-wide mood distribution. Used by
// the admin insights panel.
func (h *Campfire) MoodTrend(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	days := 14
	if v, _ := strconv.Atoi(c.Query("days")); v > 0 && v <= 60 {
		days = v
	}
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT day, mood, COUNT(*)::int
		FROM campfire_mood
		WHERE tenant_id=$1 AND day >= CURRENT_DATE - $2::int
		GROUP BY day, mood
		ORDER BY day`, tid, days)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			day   time.Time
			mood  string
			count int
		)
		if err := rows.Scan(&day, &mood, &count); err == nil {
			out = append(out, gin.H{"day": day, "mood": mood, "count": count})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

// ──────────────────────────────────────────────────────────────────────────
// Help requests
// ──────────────────────────────────────────────────────────────────────────

var validHelpKinds = map[string]bool{"help": true, "blocked": true, "review": true, "devops": true, "management": true}

func (h *Campfire) ListHelp(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	status := c.Query("status")
	args := []any{tid}
	q := `
		SELECT r.id, r.requester_id, COALESCE(u.full_name,''), COALESCE(u.email::text,''),
		       r.kind, r.title, COALESCE(r.body,''), r.status,
		       r.resolver_id, COALESCE(ur.full_name,''),
		       r.created_at, r.resolved_at
		FROM campfire_help r
		LEFT JOIN users u  ON u.id  = r.requester_id
		LEFT JOIN users ur ON ur.id = r.resolver_id
		WHERE r.tenant_id=$1`
	if status == "open" || status == "in_progress" || status == "resolved" {
		args = append(args, status)
		q += " AND r.status=$2"
	}
	q += " ORDER BY (r.status='open') DESC, r.created_at DESC LIMIT 200"
	rows, err := h.db.Query(c.Request.Context(), q, args...)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id, requester                      uuid.UUID
			resolver                           *uuid.UUID
			rname, remail, kind, title, body   string
			status, resolverName               string
			created                            time.Time
			resolved                           *time.Time
		)
		if err := rows.Scan(&id, &requester, &rname, &remail, &kind, &title, &body,
			&status, &resolver, &resolverName, &created, &resolved); err == nil {
			out = append(out, gin.H{
				"id": id, "kind": kind, "title": title, "body": body, "status": status,
				"requester":     gin.H{"id": requester, "name": rname, "email": remail},
				"resolver":      gin.H{"id": resolver, "name": resolverName},
				"created_at":    created,
				"resolved_at":   resolved,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

func (h *Campfire) CreateHelp(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Kind  string `json:"kind"  binding:"required"`
		Title string `json:"title" binding:"required,min=2"`
		Body  string `json:"body"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if !validHelpKinds[req.Kind] {
		c.JSON(400, gin.H{"error": "invalid kind"})
		return
	}
	var id uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		INSERT INTO campfire_help (tenant_id, requester_id, kind, title, body)
		VALUES ($1,$2,$3,$4,NULLIF($5,''))
		RETURNING id`,
		tid, uid, req.Kind, strings.TrimSpace(req.Title), strings.TrimSpace(req.Body)).Scan(&id); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

func (h *Campfire) UpdateHelpStatus(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct{ Status string `json:"status" binding:"required"` }
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if req.Status != "open" && req.Status != "in_progress" && req.Status != "resolved" {
		c.JSON(400, gin.H{"error": "invalid status"})
		return
	}
	resolverID := &uid
	resolvedAt := "now()"
	if req.Status == "open" {
		resolverID = nil
		resolvedAt = "NULL"
	}
	q := "UPDATE campfire_help SET status=$1, resolver_id=$2, resolved_at=" + resolvedAt +
		" WHERE id=$3 AND tenant_id=$4"
	if _, err := h.db.Exec(c.Request.Context(), q, req.Status, resolverID, id, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// ──────────────────────────────────────────────────────────────────────────
// Team rooms + messages
// ──────────────────────────────────────────────────────────────────────────

// canAccessRoom returns true when the user is allowed to see + post in this
// room. Public rooms are open to every tenant member; private rooms are
// gated by the campfire_room_members roster.
func (h *Campfire) canAccessRoom(ctx context.Context, tid, uid, roomID uuid.UUID) (bool, error) {
	var isPrivate bool
	var createdBy *uuid.UUID
	if err := h.db.QueryRow(ctx, `
		SELECT COALESCE(is_private, false), created_by FROM campfire_rooms
		WHERE id=$1 AND tenant_id=$2`, roomID, tid).Scan(&isPrivate, &createdBy); err != nil {
		return false, err
	}
	if !isPrivate {
		return true, nil
	}
	// Owners always have access to rooms they created, even if their
	// membership row went missing — re-seed it on the way through so
	// future checks short-circuit on the EXISTS branch.
	if createdBy != nil && *createdBy == uid {
		_, _ = h.db.Exec(ctx, `
			INSERT INTO campfire_room_members (room_id, user_id, added_by)
			VALUES ($1,$2,$2) ON CONFLICT DO NOTHING`, roomID, uid)
		return true, nil
	}
	var member bool
	_ = h.db.QueryRow(ctx, `
		SELECT EXISTS (
		  SELECT 1 FROM campfire_room_members
		  WHERE room_id=$1 AND user_id=$2
		)`, roomID, uid).Scan(&member)
	return member, nil
}

func (h *Campfire) ListRooms(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	// Self-heal on read: owners of private rooms who somehow aren't on the
	// roster (e.g. seeded before the membership table existed, or a half-
	// failed create-transaction) get added back. Idempotent.
	_, _ = h.db.Exec(c.Request.Context(), `
		INSERT INTO campfire_room_members (room_id, user_id, added_by)
		SELECT r.id, r.created_by, r.created_by
		  FROM campfire_rooms r
		 WHERE r.tenant_id=$1
		   AND r.created_by = $2
		   AND COALESCE(r.is_private, false) = true
		   AND NOT EXISTS (
		     SELECT 1 FROM campfire_room_members m
		      WHERE m.room_id = r.id AND m.user_id = r.created_by
		   )
		ON CONFLICT DO NOTHING`, tid, uid)

	// Private rooms are filtered to those the caller belongs to OR owns;
	// public rooms are visible to everyone in the tenant. The created_by
	// clause is the safety net for orphaned rooms — without it an owner
	// whose membership row got dropped is invisible to themselves.
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT r.id, r.slug, r.name, COALESCE(r.description,''), r.is_default,
		       COALESCE(r.is_private, false),
		       (SELECT COUNT(*) FROM campfire_messages m WHERE m.room_id=r.id) AS msg_count,
		       (SELECT MAX(m.created_at) FROM campfire_messages m WHERE m.room_id=r.id) AS last_at,
		       (SELECT COUNT(*) FROM campfire_room_members rm WHERE rm.room_id=r.id) AS member_count,
		       COALESCE(r.created_by = $2, false) AS is_owner
		FROM campfire_rooms r
		WHERE r.tenant_id=$1
		  AND (
		    COALESCE(r.is_private, false) = false
		    OR r.created_by = $2
		    OR EXISTS (
		      SELECT 1 FROM campfire_room_members rm
		       WHERE rm.room_id = r.id AND rm.user_id = $2
		    )
		  )
		ORDER BY r.is_default DESC, r.name`, tid, uid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	scanErrs := 0
	var lastScanErr string
	for rows.Next() {
		var (
			id                       uuid.UUID
			slug, name, desc         string
			def, isPrivate, isOwner  bool
			// PostgreSQL COUNT(*) returns bigint. Scanning into Go's int
			// silently fails on some pgx configs — and because the loop's
			// `if err == nil` swallows the row, the user sees an empty
			// channel list even though the rows exist and pass visibility.
			// This was the long-running "my channels don't show up" bug.
			count, memberCount       int64
			last                     *time.Time
		)
		if err := rows.Scan(&id, &slug, &name, &desc, &def, &isPrivate, &count, &last, &memberCount, &isOwner); err == nil {
			out = append(out, gin.H{
				"id": id, "slug": slug, "name": name, "description": desc,
				"is_default": def, "is_private": isPrivate, "is_owner": isOwner,
				"member_count": memberCount,
				"message_count": count, "last_message_at": last,
			})
		} else {
			scanErrs++
			lastScanErr = err.Error()
		}
	}
	// Surface scan failures via response header so a future "channels missing"
	// report is debuggable from the browser without DB access.
	if scanErrs > 0 {
		c.Header("X-Channel-Scan-Errors", fmt.Sprintf("%d (last: %s)", scanErrs, lastScanErr))
	}
	c.JSON(200, gin.H{"items": out})
}

func (h *Campfire) CreateRoom(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)

	var req struct {
		Slug        string      `json:"slug" binding:"required,min=2"`
		Name        string      `json:"name" binding:"required,min=2"`
		Description string      `json:"description"`
		IsPrivate   bool        `json:"is_private"`
		MemberIDs   []uuid.UUID `json:"member_ids"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	// Public rooms still need governance:write — they're workspace-wide and
	// shouldn't be spammed by every user. Private rooms are anyone's to spin
	// up; they only affect the invitees on their roster.
	if !req.IsPrivate && !auth.HasPermission(roles, "governance:write") {
		c.JSON(http.StatusForbidden, gin.H{
			"error": "Only admins can create workspace-wide channels. Set 'is_private' to make a team-only channel.",
		})
		return
	}

	slug := strings.ToLower(strings.TrimSpace(req.Slug))
	tx, err := h.db.Begin(c.Request.Context())
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(c.Request.Context())

	var id uuid.UUID
	if err := tx.QueryRow(c.Request.Context(), `
		INSERT INTO campfire_rooms (tenant_id, slug, name, description, is_private, created_by)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,$6)
		RETURNING id`,
		tid, slug, strings.TrimSpace(req.Name), strings.TrimSpace(req.Description),
		req.IsPrivate, uid).Scan(&id); err != nil {

		// Self-heal: the slug is already taken in this tenant. If the caller
		// is the original creator they likely got locked out by an earlier
		// failed roll-out — re-seed their membership and tell the UI which
		// existing channel to switch to. Otherwise it's a real collision.
		_ = tx.Rollback(c.Request.Context())
		var existingID, existingCreator uuid.UUID
		var existingPrivate bool
		row := h.db.QueryRow(c.Request.Context(), `
			SELECT id, COALESCE(created_by, '00000000-0000-0000-0000-000000000000'::uuid), is_private
			FROM campfire_rooms WHERE tenant_id=$1 AND slug=$2`, tid, slug)
		if err2 := row.Scan(&existingID, &existingCreator, &existingPrivate); err2 == nil {
			if existingCreator == uid {
				// Best-effort: ensure the owner is on the roster of their own
				// private room. No-op for public rooms.
				if existingPrivate {
					_, _ = h.db.Exec(c.Request.Context(), `
						INSERT INTO campfire_room_members (room_id, user_id, added_by)
						VALUES ($1,$2,$2) ON CONFLICT DO NOTHING`, existingID, uid)
				}
				c.JSON(http.StatusOK, gin.H{
					"id":      existingID,
					"healed":  true,
					"message": "A channel with that name already exists and is yours — opening it.",
				})
				return
			}
			c.JSON(http.StatusConflict, gin.H{
				"error": "A channel with that name already exists in this workspace. Pick a different name.",
				"code":  "slug_taken",
			})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Couldn't create the channel — name must be at least 2 characters and contain only letters, numbers, dashes.",
		})
		return
	}

	if req.IsPrivate {
		// Always seed the creator so they don't lock themselves out of the
		// room they just made. Then add each invited member; duplicates fold
		// via the unique PK.
		seen := map[uuid.UUID]bool{uid: true}
		if _, err := tx.Exec(c.Request.Context(), `
			INSERT INTO campfire_room_members (room_id, user_id, added_by)
			VALUES ($1,$2,$2)`, id, uid); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		for _, m := range req.MemberIDs {
			if m == uuid.Nil || seen[m] {
				continue
			}
			seen[m] = true
			if _, err := tx.Exec(c.Request.Context(), `
				INSERT INTO campfire_room_members (room_id, user_id, added_by)
				VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, id, m, uid); err != nil {
				c.JSON(500, gin.H{"error": err.Error()})
				return
			}
		}
	}

	if err := tx.Commit(c.Request.Context()); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

// ListRoomMembers returns the roster of a private room. Membership is the
// gate: only members of the room (or callers with governance:write) can see
// who else is in it.
func (h *Campfire) ListRoomMembers(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	ok, err := h.canAccessRoom(c.Request.Context(), tid, uid, roomID)
	if err != nil || !ok {
		c.JSON(http.StatusForbidden, gin.H{"error": "not a member of this channel"})
		return
	}
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT rm.user_id, COALESCE(u.full_name,''), COALESCE(u.email::text,''),
		       COALESCE(u.avatar_url,''), rm.added_at,
		       (r.created_by = rm.user_id) AS is_owner
		FROM campfire_room_members rm
		JOIN campfire_rooms r ON r.id = rm.room_id
		LEFT JOIN users u ON u.id = rm.user_id
		WHERE rm.room_id = $1
		ORDER BY is_owner DESC, u.full_name`, roomID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			userID                  uuid.UUID
			name, email, avatarURL  string
			addedAt                 time.Time
			isOwner                 bool
		)
		if err := rows.Scan(&userID, &name, &email, &avatarURL, &addedAt, &isOwner); err == nil {
			out = append(out, gin.H{
				"user_id": userID, "name": name, "email": email,
				"avatar_url": avatarURL, "added_at": addedAt, "is_owner": isOwner,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

// AddRoomMember invites a member to a private room. Only the room owner
// (or governance:write) can extend the roster — keeps the team-only promise
// from being undermined by drive-by additions.
func (h *Campfire) AddRoomMember(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	var req struct {
		UserID uuid.UUID `json:"user_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	// Owner OR governance:write may add.
	var ownerID uuid.UUID
	var isPrivate bool
	if err := h.db.QueryRow(c.Request.Context(), `
		SELECT COALESCE(created_by, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(is_private, false)
		FROM campfire_rooms WHERE id=$1 AND tenant_id=$2`, roomID, tid).Scan(&ownerID, &isPrivate); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}
	if !isPrivate {
		c.JSON(http.StatusBadRequest, gin.H{"error": "public channels have no roster — every workspace member can join"})
		return
	}
	if ownerID != uid && !auth.HasPermission(roles, "governance:write") {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the channel owner can add members"})
		return
	}
	// Confirm the invitee belongs to this tenant.
	var sameTenant bool
	_ = h.db.QueryRow(c.Request.Context(), `
		SELECT EXISTS (SELECT 1 FROM users WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL)
	`, req.UserID, tid).Scan(&sameTenant)
	if !sameTenant {
		c.JSON(http.StatusBadRequest, gin.H{"error": "user not in this workspace"})
		return
	}
	if _, err := h.db.Exec(c.Request.Context(), `
		INSERT INTO campfire_room_members (room_id, user_id, added_by)
		VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, roomID, req.UserID, uid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// RemoveRoomMember drops a member from a private room's roster. Owner or
// governance:write can remove anyone; a member can remove themselves
// (leaving the room).
func (h *Campfire) RemoveRoomMember(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad room id"})
		return
	}
	targetID, err := uuid.Parse(c.Param("uid"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad user id"})
		return
	}
	var ownerID uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		SELECT COALESCE(created_by, '00000000-0000-0000-0000-000000000000'::uuid)
		FROM campfire_rooms WHERE id=$1 AND tenant_id=$2`, roomID, tid).Scan(&ownerID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "room not found"})
		return
	}
	if targetID != uid && ownerID != uid && !auth.HasPermission(roles, "governance:write") {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the channel owner can remove other members"})
		return
	}
	if targetID == ownerID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "the owner can't leave their own channel — delete it instead"})
		return
	}
	if _, err := h.db.Exec(c.Request.Context(), `
		DELETE FROM campfire_room_members WHERE room_id=$1 AND user_id=$2`, roomID, targetID); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// DeleteRoom hard-deletes a channel and cascades messages, reactions and
// member rows via FK ON DELETE CASCADE. Allowed for the channel owner or
// any caller with governance:write (CEO / COO / super_admin). The default
// "General" channel and any other is_default=true rooms refuse to delete
// — they're the workspace fallback chat and removing them would orphan
// the UI's default-room logic.
func (h *Campfire) DeleteRoom(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad room id"})
		return
	}
	var (
		ownerID   uuid.UUID
		isDefault bool
		name      string
	)
	if err := h.db.QueryRow(c.Request.Context(), `
		SELECT COALESCE(created_by, '00000000-0000-0000-0000-000000000000'::uuid),
		       COALESCE(is_default, false),
		       name
		FROM campfire_rooms WHERE id=$1 AND tenant_id=$2`, roomID, tid).Scan(&ownerID, &isDefault, &name); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not found"})
		return
	}
	if isDefault {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "The default channel can't be deleted — it's the workspace fallback chat.",
		})
		return
	}
	if ownerID != uid && !auth.HasPermission(roles, "governance:write") {
		c.JSON(http.StatusForbidden, gin.H{
			"error": "Only the channel owner or a CEO/COO can delete this channel.",
		})
		return
	}
	// Single statement; FK cascade handles members + messages + reactions.
	if _, err := h.db.Exec(c.Request.Context(), `
		DELETE FROM campfire_rooms WHERE id=$1 AND tenant_id=$2`, roomID, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true, "deleted": name})
}

// GetRoom returns the full metadata for a single channel — used by the
// "Channel details" drawer. Access is the same as ListMessages: members,
// owner, or governance:write only.
func (h *Campfire) GetRoom(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad room id"})
		return
	}
	if ok, _ := h.canAccessRoom(c.Request.Context(), tid, uid, roomID); !ok {
		c.JSON(http.StatusForbidden, gin.H{"error": "not a member of this channel"})
		return
	}
	var (
		slug, name, desc       string
		isDefault, isPrivate   bool
		createdBy              *uuid.UUID
		createdAt              time.Time
		creatorName, creatorEm *string
		memberCount, msgCount  int64
	)
	if err := h.db.QueryRow(c.Request.Context(), `
		SELECT r.slug, r.name, COALESCE(r.description,''),
		       COALESCE(r.is_default, false), COALESCE(r.is_private, false),
		       r.created_by, r.created_at,
		       u.full_name, u.email::text,
		       (SELECT COUNT(*) FROM campfire_room_members rm WHERE rm.room_id=r.id),
		       (SELECT COUNT(*) FROM campfire_messages m WHERE m.room_id=r.id)
		FROM campfire_rooms r
		LEFT JOIN users u ON u.id = r.created_by
		WHERE r.id=$1 AND r.tenant_id=$2`,
		roomID, tid,
	).Scan(&slug, &name, &desc, &isDefault, &isPrivate, &createdBy, &createdAt,
		&creatorName, &creatorEm, &memberCount, &msgCount); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not found"})
		return
	}
	out := gin.H{
		"id":            roomID,
		"slug":          slug,
		"name":          name,
		"description":   desc,
		"is_default":    isDefault,
		"is_private":    isPrivate,
		"created_at":    createdAt,
		"member_count":  memberCount,
		"message_count": msgCount,
		"is_owner":      createdBy != nil && *createdBy == uid,
	}
	if createdBy != nil {
		out["created_by"] = gin.H{
			"id":    *createdBy,
			"name":  derefStrCF(creatorName),
			"email": derefStrCF(creatorEm),
		}
	}
	c.JSON(200, out)
}

func derefStrCF(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// UpdateRoom renames or re-describes a channel. Owner or governance:write
// only. The slug is immutable — renaming a workspace channel from
// "Engineering" to "Eng" shouldn't break URLs people have bookmarked, and
// reconciling slug history would be a bigger feature. Default channels
// can be renamed but not unmade default.
func (h *Campfire) UpdateRoom(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad room id"})
		return
	}
	var req struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	var ownerID uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		SELECT COALESCE(created_by, '00000000-0000-0000-0000-000000000000'::uuid)
		FROM campfire_rooms WHERE id=$1 AND tenant_id=$2`, roomID, tid).Scan(&ownerID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not found"})
		return
	}
	if ownerID != uid && !auth.HasPermission(roles, "governance:write") {
		c.JSON(http.StatusForbidden, gin.H{"error": "Only the channel owner or a CEO/COO can edit this channel."})
		return
	}
	// COALESCE the optional fields so callers can update one at a time.
	// NULLIF(description,'') keeps the column NULL-when-empty convention
	// the rest of the table already uses.
	var name, desc *string
	if req.Name != nil {
		v := strings.TrimSpace(*req.Name)
		if len(v) < 2 {
			c.JSON(400, gin.H{"error": "Name must be at least 2 characters."})
			return
		}
		name = &v
	}
	if req.Description != nil {
		v := strings.TrimSpace(*req.Description)
		desc = &v
	}
	if _, err := h.db.Exec(c.Request.Context(), `
		UPDATE campfire_rooms
		   SET name = COALESCE($3, name),
		       description = CASE WHEN $4::text IS NULL THEN description
		                          WHEN $4 = '' THEN NULL
		                          ELSE $4 END
		 WHERE id=$1 AND tenant_id=$2`, roomID, tid, name, desc); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// CreateRoomInvite mints a shareable join-link for a private channel.
// The token is opaque; acceptance is gated on a valid logged-in session
// in the same tenant. Public channels don't need an invite link — every
// tenant member can see them — so the endpoint refuses with 400 there.
func (h *Campfire) CreateRoomInvite(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad room id"})
		return
	}
	var req struct {
		ExpiresInHours int  `json:"expires_in_hours"`
		MaxUses        *int `json:"max_uses"`
	}
	_ = c.ShouldBindJSON(&req)
	if req.ExpiresInHours <= 0 {
		req.ExpiresInHours = 24 * 7 // default: 7 days
	}
	if req.ExpiresInHours > 24*30 {
		req.ExpiresInHours = 24 * 30 // hard ceiling: 30 days
	}
	// Must be a member or admin to issue an invite. We don't restrict to
	// the owner only — any current member can pull a friend in, which
	// matches the social model of Slack-style "shared private channels".
	if ok, _ := h.canAccessRoom(c.Request.Context(), tid, uid, roomID); !ok {
		if !auth.HasPermission(roles, "governance:write") {
			c.JSON(http.StatusForbidden, gin.H{"error": "Join the channel first to invite others."})
			return
		}
	}
	var isPrivate bool
	if err := h.db.QueryRow(c.Request.Context(), `
		SELECT COALESCE(is_private, false) FROM campfire_rooms WHERE id=$1 AND tenant_id=$2`,
		roomID, tid).Scan(&isPrivate); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not found"})
		return
	}
	if !isPrivate {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Workspace channels don't need invite links — every member can see them.",
		})
		return
	}
	tok, err := newInviteToken()
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	expiresAt := time.Now().Add(time.Duration(req.ExpiresInHours) * time.Hour)
	var inviteID uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		INSERT INTO campfire_room_invites (room_id, tenant_id, token, created_by, expires_at, max_uses)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
		roomID, tid, tok, uid, expiresAt, req.MaxUses).Scan(&inviteID); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{
		"id":         inviteID,
		"token":      tok,
		"expires_at": expiresAt,
		// Caller composes the full URL on the frontend — the backend has
		// no idea what hostname the user is browsing from.
	})
}

// ListRoomInvites returns the active (non-revoked, non-expired) invites
// on this channel so the UI can show "1 active link" + a revoke button.
func (h *Campfire) ListRoomInvites(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad room id"})
		return
	}
	if ok, _ := h.canAccessRoom(c.Request.Context(), tid, uid, roomID); !ok {
		c.JSON(http.StatusForbidden, gin.H{"error": "not a member"})
		return
	}
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT id, token, created_at, expires_at, max_uses, uses
		FROM campfire_room_invites
		WHERE room_id=$1 AND tenant_id=$2
		  AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at > now())
		ORDER BY created_at DESC`, roomID, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id                uuid.UUID
			tok               string
			createdAt         time.Time
			expiresAt         *time.Time
			maxUses, usesUsed *int
			uses              int
		)
		_ = maxUses
		_ = usesUsed
		var maxUsesNul *int
		if err := rows.Scan(&id, &tok, &createdAt, &expiresAt, &maxUsesNul, &uses); err == nil {
			out = append(out, gin.H{
				"id":         id,
				"token":      tok,
				"created_at": createdAt,
				"expires_at": expiresAt,
				"max_uses":   maxUsesNul,
				"uses":       uses,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

// RevokeRoomInvite kills an active link. Same access rule as creation:
// any current member can revoke any link on the channel they're in. We
// could narrow this to the link's creator + owner, but the social loop
// (someone spam-shares a link) needs to be fixable by anyone present.
func (h *Campfire) RevokeRoomInvite(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad room id"})
		return
	}
	inviteID, err := uuid.Parse(c.Param("inviteID"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad invite id"})
		return
	}
	if ok, _ := h.canAccessRoom(c.Request.Context(), tid, uid, roomID); !ok {
		c.JSON(http.StatusForbidden, gin.H{"error": "not a member"})
		return
	}
	if _, err := h.db.Exec(c.Request.Context(), `
		UPDATE campfire_room_invites SET revoked_at = now()
		 WHERE id=$1 AND room_id=$2 AND tenant_id=$3 AND revoked_at IS NULL`,
		inviteID, roomID, tid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// PreviewInvite returns enough info for the join-confirmation screen —
// channel name + member count + creator. Authenticated tenant-scoped:
// we don't leak the channel name across tenants. If the caller isn't in
// the right tenant we return 404 (not 403) to avoid confirming the
// token's existence to outsiders.
func (h *Campfire) PreviewInvite(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	token := strings.TrimSpace(c.Param("token"))
	if token == "" {
		c.JSON(400, gin.H{"error": "missing token"})
		return
	}
	var (
		roomID      uuid.UUID
		name, desc  string
		isPrivate   bool
		expiresAt   *time.Time
		revoked     *time.Time
		maxUses     *int
		uses        int
		memberCount int64
	)
	if err := h.db.QueryRow(c.Request.Context(), `
		SELECT r.id, r.name, COALESCE(r.description,''), COALESCE(r.is_private, false),
		       i.expires_at, i.revoked_at, i.max_uses, i.uses,
		       (SELECT COUNT(*) FROM campfire_room_members rm WHERE rm.room_id=r.id)
		FROM campfire_room_invites i
		JOIN campfire_rooms r ON r.id = i.room_id
		WHERE i.token=$1 AND i.tenant_id=$2`, token, tid).Scan(
		&roomID, &name, &desc, &isPrivate, &expiresAt, &revoked, &maxUses, &uses, &memberCount); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "invite not found"})
		return
	}
	status := "active"
	switch {
	case revoked != nil:
		status = "revoked"
	case expiresAt != nil && expiresAt.Before(time.Now()):
		status = "expired"
	case maxUses != nil && uses >= *maxUses:
		status = "exhausted"
	}
	c.JSON(200, gin.H{
		"room_id":      roomID,
		"name":         name,
		"description":  desc,
		"is_private":   isPrivate,
		"member_count": memberCount,
		"status":       status,
		"expires_at":   expiresAt,
	})
}

// AcceptInvite adds the caller to the channel referenced by the token.
// Idempotent — if the user is already a member, we still return success
// (so opening an invite link the user already joined is a no-op redirect
// instead of an error wall).
func (h *Campfire) AcceptInvite(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	token := strings.TrimSpace(c.Param("token"))
	if token == "" {
		c.JSON(400, gin.H{"error": "missing token"})
		return
	}
	tx, err := h.db.Begin(c.Request.Context())
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback(c.Request.Context())

	var (
		inviteID, roomID uuid.UUID
		expiresAt        *time.Time
		revoked          *time.Time
		maxUses          *int
		uses             int
	)
	if err := tx.QueryRow(c.Request.Context(), `
		SELECT id, room_id, expires_at, revoked_at, max_uses, uses
		FROM campfire_room_invites WHERE token=$1 AND tenant_id=$2 FOR UPDATE`,
		token, tid).Scan(&inviteID, &roomID, &expiresAt, &revoked, &maxUses, &uses); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "invite not found"})
		return
	}
	if revoked != nil {
		c.JSON(http.StatusGone, gin.H{"error": "This invite link has been revoked."})
		return
	}
	if expiresAt != nil && expiresAt.Before(time.Now()) {
		c.JSON(http.StatusGone, gin.H{"error": "This invite link has expired."})
		return
	}
	if maxUses != nil && uses >= *maxUses {
		c.JSON(http.StatusGone, gin.H{"error": "This invite link has hit its use limit."})
		return
	}
	if _, err := tx.Exec(c.Request.Context(), `
		INSERT INTO campfire_room_members (room_id, user_id, added_by)
		VALUES ($1,$2,$2) ON CONFLICT DO NOTHING`, roomID, uid); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if _, err := tx.Exec(c.Request.Context(), `
		UPDATE campfire_room_invites SET uses = uses + 1 WHERE id=$1`, inviteID); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if err := tx.Commit(c.Request.Context()); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true, "room_id": roomID})
}

// newInviteToken returns a URL-safe random string. 24 bytes ≈ 32 chars
// once base64-encoded — long enough to be unguessable without burning
// real-estate in a chat-bot DM.
func newInviteToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (h *Campfire) ListMessages(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	if ok, _ := h.canAccessRoom(c.Request.Context(), tid, uid, roomID); !ok {
		c.JSON(http.StatusForbidden, gin.H{"error": "not a member of this channel"})
		return
	}
	// We return newest-200 in chronological order so the UI can scroll-bottom.
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT m.id, m.author_id, COALESCE(u.full_name,''), COALESCE(u.email::text,''),
		       COALESCE(u.avatar_url,''),
		       m.body, m.created_at
		FROM (
		  SELECT * FROM campfire_messages
		   WHERE tenant_id=$1 AND room_id=$2
		   ORDER BY created_at DESC LIMIT 200
		) m
		LEFT JOIN users u ON u.id = m.author_id
		ORDER BY m.created_at`, tid, roomID)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	ids := []uuid.UUID{}
	for rows.Next() {
		var (
			id                          uuid.UUID
			author                      *uuid.UUID
			name, email, avatar, body   string
			created                     time.Time
		)
		if err := rows.Scan(&id, &author, &name, &email, &avatar, &body, &created); err == nil {
			out = append(out, gin.H{
				"id": id, "author_id": author, "author_name": name, "author_email": email,
				"author_avatar_url": avatar,
				"body": body, "created_at": created,
			})
			ids = append(ids, id)
		}
	}
	reactions := loadReactions(c.Request.Context(), h.db, "message", ids, uid)
	for _, m := range out {
		m["reactions"] = reactions[m["id"].(uuid.UUID)]
	}
	c.JSON(200, gin.H{"items": out})
}

func (h *Campfire) SendMessage(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	if ok, _ := h.canAccessRoom(c.Request.Context(), tid, uid, roomID); !ok {
		c.JSON(http.StatusForbidden, gin.H{"error": "not a member of this channel"})
		return
	}
	var req struct{ Body string `json:"body" binding:"required,min=1"` }
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	var id uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		INSERT INTO campfire_messages (tenant_id, room_id, author_id, body)
		VALUES ($1,$2,$3,$4) RETURNING id`,
		tid, roomID, uid, strings.TrimSpace(req.Body)).Scan(&id); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	go h.dispatchMentions(context.Background(), tid, uid, req.Body, "Campfire room message", "/campfire?room="+roomID.String()+"&message="+id.String())
	c.JSON(201, gin.H{"id": id})
}

// ──────────────────────────────────────────────────────────────────────────
// Insights — admin-only snapshot of engagement
// ──────────────────────────────────────────────────────────────────────────

func (h *Campfire) Insights(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	ctx := c.Request.Context()

	var activeToday, kudosCount, openHelp, unresolvedAvgMin int
	var moodAvg *float64

	_ = h.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM users
		WHERE tenant_id=$1 AND deleted_at IS NULL
		  AND last_seen_at IS NOT NULL AND last_seen_at > now() - interval '24 hours'`,
		tid).Scan(&activeToday)

	_ = h.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM campfire_kudos
		WHERE tenant_id=$1 AND created_at > now() - interval '7 days'`,
		tid).Scan(&kudosCount)

	_ = h.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM campfire_help
		WHERE tenant_id=$1 AND status IN ('open','in_progress')`,
		tid).Scan(&openHelp)

	// Mood average over last 7 days, mapped great=5..overloaded=1 so a
	// number out of 5 is easy to render as a smiley dial.
	_ = h.db.QueryRow(ctx, `
		SELECT AVG(CASE mood
		  WHEN 'great' THEN 5
		  WHEN 'good' THEN 4
		  WHEN 'neutral' THEN 3
		  WHEN 'stressed' THEN 2
		  WHEN 'overloaded' THEN 1
		END)::float8
		FROM campfire_mood
		WHERE tenant_id=$1 AND day >= CURRENT_DATE - 6`, tid).Scan(&moodAvg)

	// Average time to resolution on resolved help requests in the last 30 days.
	_ = h.db.QueryRow(ctx, `
		SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60), 0)::int
		FROM campfire_help
		WHERE tenant_id=$1 AND resolved_at IS NOT NULL
		  AND resolved_at > now() - interval '30 days'`,
		tid).Scan(&unresolvedAvgMin)

	// Engagement score: rough composite — active today + recent kudos + posts
	// in last 7 days, normalised to 0..100. Tunable, surfaced as a single
	// "are people leaning in?" number.
	var posts7d, totalUsers int
	_ = h.db.QueryRow(ctx, `SELECT COUNT(*) FROM campfire_posts WHERE tenant_id=$1 AND created_at > now() - interval '7 days'`, tid).Scan(&posts7d)
	_ = h.db.QueryRow(ctx, `SELECT COUNT(*) FROM users WHERE tenant_id=$1 AND deleted_at IS NULL AND status='active'`, tid).Scan(&totalUsers)
	score := 0
	if totalUsers > 0 {
		// 50% activity (active today / total), 30% kudos, 20% posts
		score = (50*activeToday/totalUsers) + min(30, kudosCount*3) + min(20, posts7d*2)
		if score > 100 {
			score = 100
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"active_today":      activeToday,
		"total_active":      totalUsers,
		"kudos_7d":          kudosCount,
		"posts_7d":          posts7d,
		"open_help":         openHelp,
		"avg_resolution_minutes": unresolvedAvgMin,
		"mood_avg_5":        moodAvg,
		"engagement_score":  score,
	})
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ──────────────────────────────────────────────────────────────────────────
// Unread / last-seen — drives the top-bar bell badge
// ──────────────────────────────────────────────────────────────────────────

// Unread — GET /api/v1/campfire/unread
// Returns the count of campfire activity since the caller last opened the
// feed, plus the most recent few items so the bell can show a peek without
// a second round-trip. "Activity" = posts the caller didn't author + comments
// on posts they engaged with.
func (h *Campfire) Unread(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)

	var lastSeen time.Time
	_ = h.db.QueryRow(c, `SELECT campfire_last_seen_at FROM users WHERE id=$1`, uid).Scan(&lastSeen)

	var postCount, commentCount int
	_ = h.db.QueryRow(c, `
		SELECT COUNT(*) FROM campfire_posts
		 WHERE tenant_id=$1 AND author_id <> $2 AND created_at > $3`,
		tid, uid, lastSeen).Scan(&postCount)
	_ = h.db.QueryRow(c, `
		SELECT COUNT(*) FROM campfire_comments cc
		  JOIN campfire_posts p ON p.id = cc.post_id
		 WHERE p.tenant_id=$1 AND cc.author_id <> $2 AND cc.created_at > $3`,
		tid, uid, lastSeen).Scan(&commentCount)

	// Pull up to 5 most-recent unread posts for the bell preview.
	preview := []gin.H{}
	if rows, err := h.db.Query(c, `
		SELECT p.id, p.title, p.body, p.kind, p.created_at,
		       COALESCE(u.full_name, ''), COALESCE(u.email::text, '')
		  FROM campfire_posts p
		  JOIN users u ON u.id = p.author_id
		 WHERE p.tenant_id=$1 AND p.author_id <> $2 AND p.created_at > $3
		 ORDER BY p.created_at DESC LIMIT 5`, tid, uid, lastSeen); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				id                            uuid.UUID
				title, body, kind, name, mail string
				at                            time.Time
			)
			if err := rows.Scan(&id, &title, &body, &kind, &at, &name, &mail); err == nil {
				snippet := body
				if len(snippet) > 140 {
					snippet = snippet[:140] + "…"
				}
				preview = append(preview, gin.H{
					"id": id, "title": title, "snippet": snippet, "kind": kind,
					"created_at": at, "author_name": name, "author_email": mail,
				})
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"count":         postCount + commentCount,
		"post_count":    postCount,
		"comment_count": commentCount,
		"preview":       preview,
		"last_seen_at":  lastSeen,
	})
}

// MarkSeen — POST /api/v1/campfire/mark-seen
// Stamps the caller's campfire_last_seen_at to now(). Called when they open
// the page (or the bell dropdown) so the badge resets.
func (h *Campfire) MarkSeen(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	if _, err := h.db.Exec(c, `UPDATE users SET campfire_last_seen_at = now() WHERE id=$1`, uid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ──────────────────────────────────────────────────────────────────────────
// Link preview — server-side OG metadata fetch
//
// The frontend calls /campfire/link-preview?url=… whenever it sees a URL in a
// post / comment / message. We fetch the page server-side (avoids CORS), pull
// open-graph + basic <title>/<meta description>, and cache for 30 minutes per
// URL so popular links don't hammer outside hosts.
// ──────────────────────────────────────────────────────────────────────────

var (
	previewTTL = 30 * time.Minute
	httpClient = &http.Client{
		Timeout: 8 * time.Second,
		// Follow up to 5 redirects — news sites like to bounce through
		// consent / locale gates before delivering the article HTML.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}

	// Open Graph (property="og:*") in either attribute order.
	reMetaProp  = regexp.MustCompile(`(?is)<meta[^>]+property=["']og:(title|description|image|site_name)["'][^>]*content=["']([^"']+)["']`)
	reMetaProp2 = regexp.MustCompile(`(?is)<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:(title|description|image|site_name)["']`)
	// Twitter card fallback — many sites only set twitter:* (or set it more
	// reliably than og:*). Treated as lower priority than og:* via merge order.
	reMetaTw  = regexp.MustCompile(`(?is)<meta[^>]+name=["']twitter:(title|description|image|site)["'][^>]*content=["']([^"']+)["']`)
	reMetaTw2 = regexp.MustCompile(`(?is)<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:(title|description|image|site)["']`)
	// Plain description / favicon / title fallbacks.
	reMetaName = regexp.MustCompile(`(?is)<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']`)
	reMetaName2 = regexp.MustCompile(`(?is)<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']`)
	reTitle    = regexp.MustCompile(`(?is)<title[^>]*>([^<]+)</title>`)
	reFavicon  = regexp.MustCompile(`(?is)<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']`)
)

func (h *Campfire) LinkPreview(c *gin.Context) {
	raw := strings.TrimSpace(c.Query("url"))
	if raw == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "url required"})
		return
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "url must be http(s)"})
		return
	}

	// In-memory cache lookup. The cache lives for the lifetime of the process —
	// a restart wipes it, which is fine since fetches are cheap.
	h.previewMu.RLock()
	if cp, ok := h.previewCache[raw]; ok && time.Since(cp.at) < previewTTL {
		h.previewMu.RUnlock()
		c.JSON(http.StatusOK, cp.data)
		return
	}
	h.previewMu.RUnlock()

	preview := fetchPreview(c.Request.Context(), raw)
	h.previewMu.Lock()
	h.previewCache[raw] = cachedPreview{at: time.Now(), data: preview}
	h.previewMu.Unlock()

	c.JSON(http.StatusOK, preview)
}

func fetchPreview(ctx context.Context, raw string) linkPreview {
	// Always seed the hostname so even a total fetch failure gives the UI
	// something to render (a hostname pill linking back to the URL).
	out := linkPreview{URL: raw}
	if u, err := url.Parse(raw); err == nil {
		out.SiteName = strings.TrimPrefix(u.Hostname(), "www.")
	}

	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return out
	}
	// Pretend to be a real browser. Some big sites (BBC, NYT, anything behind
	// Cloudflare's bot mitigation) serve a bare consent page or 403 to anything
	// that doesn't look like a desktop browser. Use a real-looking UA + an
	// Accept-Language so we land on the article HTML, not a stub.
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	resp, err := httpClient.Do(req)
	if err != nil {
		return out
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return out
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024)) // 1MB cap
	if err != nil {
		return out
	}
	html := string(body)
	base := baseURL(raw)

	// Open Graph (preferred).
	for _, m := range reMetaProp.FindAllStringSubmatch(html, -1) {
		assignPreview(&out, m[1], m[2])
	}
	for _, m := range reMetaProp2.FindAllStringSubmatch(html, -1) {
		assignPreview(&out, m[2], m[1])
	}
	// Twitter cards — fill gaps only, never overwrite og:*.
	for _, m := range reMetaTw.FindAllStringSubmatch(html, -1) {
		assignPreviewIfEmpty(&out, twKey(m[1]), m[2])
	}
	for _, m := range reMetaTw2.FindAllStringSubmatch(html, -1) {
		assignPreviewIfEmpty(&out, twKey(m[2]), m[1])
	}
	// Plain <meta name="description"> as a last-resort body line.
	if out.Description == "" {
		if m := reMetaName.FindStringSubmatch(html); len(m) > 1 {
			out.Description = strings.TrimSpace(decodeHTML(m[1]))
		} else if m := reMetaName2.FindStringSubmatch(html); len(m) > 1 {
			out.Description = strings.TrimSpace(decodeHTML(m[1]))
		}
	}
	if out.Title == "" {
		if m := reTitle.FindStringSubmatch(html); len(m) > 1 {
			out.Title = strings.TrimSpace(decodeHTML(m[1]))
		}
	}
	if out.Image != "" {
		out.Image = resolveURL(base, out.Image)
	}
	// Favicon for sites with no og:image (so the card still has *something*
	// visual). Prefer the explicit <link rel="icon"> if present, else the
	// well-known /favicon.ico fallback.
	if m := reFavicon.FindStringSubmatch(html); len(m) > 1 {
		out.Favicon = resolveURL(base, decodeHTML(m[1]))
	} else if base != "" {
		out.Favicon = base + "/favicon.ico"
	}
	return out
}

func twKey(s string) string {
	if s == "site" {
		return "site_name"
	}
	return s
}

func baseURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// resolveURL normalises a meta-tag href into a fully qualified URL. Handles
// "//cdn.example.com/img.jpg" (protocol-relative), "/path/img.jpg" (root-
// relative) and pass-through for already-absolute URLs.
func resolveURL(base, href string) string {
	href = strings.TrimSpace(href)
	if href == "" {
		return ""
	}
	if strings.HasPrefix(href, "//") {
		return "https:" + href
	}
	if strings.HasPrefix(href, "http://") || strings.HasPrefix(href, "https://") {
		return href
	}
	if strings.HasPrefix(href, "/") && base != "" {
		return base + href
	}
	return href
}

func assignPreviewIfEmpty(out *linkPreview, key, val string) {
	val = decodeHTML(strings.TrimSpace(val))
	switch key {
	case "title":
		if out.Title == "" {
			out.Title = val
		}
	case "description":
		if out.Description == "" {
			out.Description = val
		}
	case "image":
		if out.Image == "" {
			out.Image = val
		}
	case "site_name":
		if out.SiteName == "" {
			out.SiteName = val
		}
	}
}

func assignPreview(out *linkPreview, key, val string) {
	val = decodeHTML(strings.TrimSpace(val))
	switch key {
	case "title":
		out.Title = val
	case "description":
		out.Description = val
	case "image":
		out.Image = val
	case "site_name":
		out.SiteName = val
	}
}

func decodeHTML(s string) string {
	r := strings.NewReplacer(
		"&amp;", "&", "&lt;", "<", "&gt;", ">",
		"&quot;", `"`, "&#39;", "'", "&apos;", "'",
		"&nbsp;", " ",
	)
	return r.Replace(s)
}

// ──────────────────────────────────────────────────────────────────────────
// Today's spotlight — the smart card at the top of the feed.
//
// Surfaces moments worth noticing: people who joined this week, who's on
// leave today, recent celebrations, and the day's top reaction-getter.
// One small payload powers the whole hero card.
// ──────────────────────────────────────────────────────────────────────────

func (h *Campfire) Spotlight(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	ctx := c.Request.Context()

	// People who joined in the last 14 days. Uses users.created_at as a proxy
	// for hire date — fine until we add a dedicated column.
	joiners := []gin.H{}
	if rows, err := h.db.Query(ctx, `
		SELECT id, COALESCE(full_name,''), email::text, created_at
		FROM users
		WHERE tenant_id=$1 AND deleted_at IS NULL
		  AND created_at > now() - interval '14 days'
		ORDER BY created_at DESC LIMIT 5`, tid); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			var name, email string
			var created time.Time
			if err := rows.Scan(&id, &name, &email, &created); err == nil {
				joiners = append(joiners, gin.H{
					"id": id, "name": name, "email": email, "joined_at": created,
				})
			}
		}
	}

	// On-leave today — derived from approved leave_requests overlapping today.
	onLeave := []gin.H{}
	if rows, err := h.db.Query(ctx, `
		SELECT u.id, COALESCE(u.full_name,''), u.email::text, lr.end_date
		FROM leave_requests lr
		JOIN users u ON u.id = lr.user_id
		WHERE lr.tenant_id=$1 AND lr.status='approved'
		  AND CURRENT_DATE BETWEEN lr.start_date AND lr.end_date
		ORDER BY u.full_name`, tid); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			var name, email string
			var back time.Time
			if err := rows.Scan(&id, &name, &email, &back); err == nil {
				onLeave = append(onLeave, gin.H{
					"id": id, "name": name, "email": email, "back_on": back,
				})
			}
		}
	}

	// Top post from the last 7 days by reaction count — surfaces what the team
	// is rallying around without a manual "pin".
	var trending gin.H
	{
		var (
			pid                                uuid.UUID
			authorName, authorEmail, kind, title, body string
			created                            time.Time
			reactionCount                      int
		)
		err := h.db.QueryRow(ctx, `
			SELECT p.id, COALESCE(u.full_name,''), COALESCE(u.email::text,''),
			       p.kind, COALESCE(p.title,''), p.body, p.created_at,
			       (SELECT COUNT(*) FROM campfire_reactions r WHERE r.target_type='post' AND r.target_id=p.id)::int
			FROM campfire_posts p
			LEFT JOIN users u ON u.id = p.author_id
			WHERE p.tenant_id=$1 AND p.created_at > now() - interval '7 days'
			ORDER BY (SELECT COUNT(*) FROM campfire_reactions r WHERE r.target_type='post' AND r.target_id=p.id) DESC,
			         p.created_at DESC
			LIMIT 1`, tid).Scan(&pid, &authorName, &authorEmail, &kind, &title, &body, &created, &reactionCount)
		if err == nil && reactionCount > 0 {
			trending = gin.H{
				"id":           pid,
				"author_name":  authorName,
				"author_email": authorEmail,
				"kind":         kind,
				"title":        title,
				"body":         body,
				"created_at":   created,
				"reactions":    reactionCount,
			}
		}
	}

	// Top kudos receiver in the last 7 days — celebrates the person the
	// workspace is rallying around.
	var topKudo gin.H
	{
		var (
			uid              uuid.UUID
			name, email      string
			count            int
			badge, lastMsg   string
		)
		err := h.db.QueryRow(ctx, `
			SELECT u.id, COALESCE(u.full_name,''), u.email::text, k.cnt::int,
			       COALESCE(k.last_badge, ''),  COALESCE(k.last_message, '')
			FROM (
			  SELECT to_user_id,
			         COUNT(*)                                      AS cnt,
			         (ARRAY_AGG(badge   ORDER BY created_at DESC))[1] AS last_badge,
			         (ARRAY_AGG(message ORDER BY created_at DESC))[1] AS last_message
			    FROM campfire_kudos
			   WHERE tenant_id=$1 AND created_at > now() - interval '7 days'
			   GROUP BY to_user_id
			   ORDER BY cnt DESC
			   LIMIT 1
			) k
			JOIN users u ON u.id = k.to_user_id`, tid).
			Scan(&uid, &name, &email, &count, &badge, &lastMsg)
		if err == nil && count > 0 {
			topKudo = gin.H{
				"id":        uid,
				"name":      name,
				"email":     email,
				"count":     count,
				"badge":     badge,
				"last_note": lastMsg,
			}
		}
	}

	// Most engaging member — sum of posts authored, comments left, kudos
	// given, and reactions placed in the last 7 days. A weighted heuristic
	// gives more credit to authoring than passively reacting.
	var topEngager gin.H
	{
		var (
			uid              uuid.UUID
			name, email      string
			score            int
		)
		err := h.db.QueryRow(ctx, `
			SELECT u.id, COALESCE(u.full_name,''), u.email::text, e.score::int
			FROM (
			  SELECT actor_id AS user_id, SUM(weight) AS score FROM (
			    SELECT author_id   AS actor_id, 3 AS weight FROM campfire_posts    WHERE tenant_id=$1 AND created_at > now() - interval '7 days' AND author_id   IS NOT NULL
			    UNION ALL
			    SELECT author_id   AS actor_id, 2 AS weight FROM campfire_comments WHERE tenant_id=$1 AND created_at > now() - interval '7 days' AND author_id   IS NOT NULL
			    UNION ALL
			    SELECT from_user_id AS actor_id, 2 AS weight FROM campfire_kudos   WHERE tenant_id=$1 AND created_at > now() - interval '7 days'
			    UNION ALL
			    SELECT user_id     AS actor_id, 1 AS weight FROM campfire_reactions WHERE tenant_id=$1 AND created_at > now() - interval '7 days'
			  ) acts
			  GROUP BY actor_id
			  ORDER BY score DESC
			  LIMIT 1
			) e
			JOIN users u ON u.id = e.user_id`, tid).
			Scan(&uid, &name, &email, &score)
		if err == nil && score > 0 {
			topEngager = gin.H{
				"id": uid, "name": name, "email": email, "score": score,
			}
		}
	}

	// Work anniversaries in the next 14 days — uses users.created_at as the
	// proxy hire date. Only matches when they've been with the team at least
	// one full year (no one wants "0-year anniversary" pings on day 1).
	anniversaries := []gin.H{}
	if rows, err := h.db.Query(ctx, `
		SELECT id, COALESCE(full_name,''), email::text, created_at,
		       date_part('year', age(CURRENT_DATE, created_at))::int AS years
		  FROM users
		 WHERE tenant_id=$1 AND deleted_at IS NULL AND status='active'
		   AND created_at <= CURRENT_DATE - interval '1 year'
		   AND (
		     (date_part('month', created_at) = date_part('month', CURRENT_DATE) AND
		      date_part('day',   created_at) BETWEEN date_part('day', CURRENT_DATE)
		                                         AND date_part('day', CURRENT_DATE) + 13)
		     OR
		     (date_part('month', created_at) = date_part('month', CURRENT_DATE + interval '14 days') AND
		      date_part('day',   created_at) <= date_part('day', CURRENT_DATE + interval '14 days'))
		   )
		 ORDER BY date_part('month', created_at), date_part('day', created_at)
		 LIMIT 4`, tid); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			var name, email string
			var hireDate time.Time
			var years int
			if err := rows.Scan(&id, &name, &email, &hireDate, &years); err == nil {
				anniversaries = append(anniversaries, gin.H{
					"id": id, "name": name, "email": email,
					"hire_date": hireDate, "years": years,
				})
			}
		}
	}

	// Recent celebration / win posts from the last 7 days — pure feel-good.
	celebrations := []gin.H{}
	if rows, err := h.db.Query(ctx, `
		SELECT p.id, COALESCE(u.full_name,''), u.email::text,
		       p.kind, COALESCE(p.title,''), p.body, p.created_at
		FROM campfire_posts p
		LEFT JOIN users u ON u.id = p.author_id
		WHERE p.tenant_id=$1
		  AND p.kind IN ('win','celebration','anniversary','birthday')
		  AND p.created_at > now() - interval '7 days'
		ORDER BY p.created_at DESC LIMIT 3`, tid); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			var name, email, kind, title, body string
			var created time.Time
			if err := rows.Scan(&id, &name, &email, &kind, &title, &body, &created); err == nil {
				celebrations = append(celebrations, gin.H{
					"id":           id,
					"author_name":  name,
					"author_email": email,
					"kind":         kind,
					"title":        title,
					"body":         body,
					"created_at":   created,
				})
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"new_joiners":   joiners,
		"on_leave":      onLeave,
		"trending":      trending,
		"top_kudo":      topKudo,
		"top_engager":   topEngager,
		"anniversaries": anniversaries,
		"celebrations":  celebrations,
	})
}

// ──────────────────────────────────────────────────────────────────────────
// @mention dispatch — call this after writing any user-authored content with
// a body. Best-effort, non-blocking. Looks up mentioned emails/names against
// the tenant directory; missing handles are silently ignored.
// ──────────────────────────────────────────────────────────────────────────

var reMention = regexp.MustCompile(`@([a-zA-Z0-9_.+-]+)`)

func (h *Campfire) dispatchMentions(ctx context.Context, tid, authorID uuid.UUID, body, where, link string) {
	if h.notify == nil || h.db == nil {
		return
	}
	matches := reMention.FindAllStringSubmatch(body, -1)
	if len(matches) == 0 {
		return
	}
	handles := []string{}
	seen := map[string]bool{}
	for _, m := range matches {
		h := strings.ToLower(m[1])
		if !seen[h] {
			seen[h] = true
			handles = append(handles, h)
		}
	}
	// Match against the local part of the email OR the full name (lowercased
	// & spaces stripped). Picks up @sadiq, @sadiq.arogundade, @sadiqa, etc.
	rows, err := h.db.Query(ctx, `
		SELECT id, COALESCE(full_name,''), email::text
		FROM users
		WHERE tenant_id=$1 AND deleted_at IS NULL AND status='active'
		  AND (
		    lower(split_part(email::text,'@',1)) = ANY($2)
		    OR lower(regexp_replace(full_name, '\s+', '', 'g')) = ANY($2)
		    OR lower(split_part(full_name,' ',1)) = ANY($2)
		  )`, tid, handles)
	if err != nil {
		return
	}
	defer rows.Close()
	recipients := []notifications.Recipient{}
	for rows.Next() {
		var id uuid.UUID
		var name, email string
		if err := rows.Scan(&id, &name, &email); err == nil && id != authorID {
			recipients = append(recipients, notifications.Recipient{UserID: &id})
		}
	}
	if len(recipients) == 0 {
		return
	}

	var authorName string
	_ = h.db.QueryRow(ctx,
		`SELECT COALESCE(NULLIF(full_name,''), email::text) FROM users WHERE id=$1`, authorID,
	).Scan(&authorName)

	h.notify.Notify(ctx, notifications.Event{
		Kind:       "task.comment_mention", // reuse — the catalog string fits
		TenantID:   tid,
		Recipients: recipients,
		Payload: map[string]any{
			"Author": authorName,
			"Title":  "in " + where,
			"Where":  where,
			"Body":   truncate(body, 240),
		},
		DedupeKey: "campfire.mention:" + where + ":" + truncate(body, 24),
		Link:      link,
	})
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
