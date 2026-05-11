// Package handlers — campfire.go
//
// Campfire is the workspace's social layer: pulse feed, recognition, mood
// check-ins, help requests, team chat rooms, and a small admin insights panel.
// All endpoints are tenant-scoped, polling-friendly (no websockets yet), and
// share a polymorphic reaction model.
package handlers

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

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
	since := time.Since(*lastSeen)
	switch {
	case since < 2*time.Minute:
		return "online"
	case since < 10*time.Minute:
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
}

func (h *Campfire) ListPosts(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)

	limit := 50
	if v, _ := strconv.Atoi(c.Query("limit")); v > 0 && v <= 200 {
		limit = v
	}

	// Pinned first (newest pinned), then chronological. Single query with a
	// computed sort key.
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT p.id, p.author_id, COALESCE(u.full_name,''), COALESCE(u.email::text,''),
		       p.kind, COALESCE(p.title,''), p.body, p.meta, p.pinned, p.created_at,
		       (SELECT COUNT(*) FROM campfire_comments cc WHERE cc.post_id=p.id) AS comment_count
		FROM campfire_posts p
		LEFT JOIN users u ON u.id = p.author_id
		WHERE p.tenant_id=$1
		ORDER BY p.pinned DESC, p.created_at DESC
		LIMIT $2`, tid, limit)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	posts := []gin.H{}
	postIDs := []uuid.UUID{}
	for rows.Next() {
		var (
			id                                uuid.UUID
			authorID                          *uuid.UUID
			authorName, authorEmail, kind     string
			title, body                       string
			meta                              map[string]any
			pinned                            bool
			created                           time.Time
			commentCount                      int
		)
		if err := rows.Scan(&id, &authorID, &authorName, &authorEmail, &kind,
			&title, &body, &meta, &pinned, &created, &commentCount); err == nil {
			posts = append(posts, gin.H{
				"id": id, "author_id": authorID, "author_name": authorName, "author_email": authorEmail,
				"kind": kind, "title": title, "body": body, "meta": meta,
				"pinned": pinned, "created_at": created,
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

	c.JSON(200, gin.H{"items": posts})
}

func (h *Campfire) CreatePost(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req struct {
		Kind   string         `json:"kind"   binding:"required"`
		Title  string         `json:"title"`
		Body   string         `json:"body"   binding:"required,min=1"`
		Meta   map[string]any `json:"meta"`
		Pinned bool           `json:"pinned"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if !validPostKinds[req.Kind] {
		c.JSON(400, gin.H{"error": "invalid kind"})
		return
	}
	if req.Meta == nil {
		req.Meta = map[string]any{}
	}
	var id uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		INSERT INTO campfire_posts (tenant_id, author_id, kind, title, body, meta, pinned)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7) RETURNING id`,
		tid, uid, req.Kind, strings.TrimSpace(req.Title), strings.TrimSpace(req.Body),
		req.Meta, req.Pinned).Scan(&id); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Fan out @mention pings — author's body is the source of truth.
	go h.dispatchMentions(context.Background(), tid, uid, req.Body, "Campfire post", "/campfire")

	c.JSON(201, gin.H{"id": id})
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
	// Authors can delete their own; admins (governance:write) can delete any —
	// that permission is enforced via the route. So here we simply scope by
	// tenant and let the route guard handle access.
	_ = uid
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
		       c.body, c.created_at
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
			id                  uuid.UUID
			author              *uuid.UUID
			name, email, body   string
			created             time.Time
		)
		if err := rows.Scan(&id, &author, &name, &email, &body, &created); err == nil {
			out = append(out, gin.H{
				"id": id, "author_id": author, "author_name": name, "author_email": email,
				"body": body, "created_at": created,
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
	go h.dispatchMentions(context.Background(), tid, uid, req.Body, "Campfire comment", "/campfire")
	c.JSON(201, gin.H{"id": id})
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
	c.JSON(200, gin.H{"added": added})
}

type reactionSummary struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
	Mine  bool   `json:"mine"`
}

// loadReactions returns a map of target_id → []reactionSummary for the given
// IDs. Returns an empty map if ids is empty.
func loadReactions(ctx context.Context, db *pgxpool.Pool, targetType string, ids []uuid.UUID, userID uuid.UUID) map[uuid.UUID][]reactionSummary {
	out := map[uuid.UUID][]reactionSummary{}
	if len(ids) == 0 {
		return out
	}
	rows, err := db.Query(ctx, `
		SELECT target_id, emoji, COUNT(*)::int,
		       BOOL_OR(user_id = $1) AS mine
		FROM campfire_reactions
		WHERE target_type=$2 AND target_id = ANY($3)
		GROUP BY target_id, emoji
		ORDER BY target_id, emoji`,
		userID, targetType, ids)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var tid uuid.UUID
		var r reactionSummary
		if err := rows.Scan(&tid, &r.Emoji, &r.Count, &r.Mine); err == nil {
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
	c.JSON(201, gin.H{"id": id})
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

func (h *Campfire) ListRooms(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT r.id, r.slug, r.name, COALESCE(r.description,''), r.is_default,
		       (SELECT COUNT(*) FROM campfire_messages m WHERE m.room_id=r.id) AS msg_count,
		       (SELECT MAX(m.created_at) FROM campfire_messages m WHERE m.room_id=r.id) AS last_at
		FROM campfire_rooms r
		WHERE r.tenant_id=$1
		ORDER BY r.is_default DESC, r.name`, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var (
			id              uuid.UUID
			slug, name, desc string
			def             bool
			count           int
			last            *time.Time
		)
		if err := rows.Scan(&id, &slug, &name, &desc, &def, &count, &last); err == nil {
			out = append(out, gin.H{
				"id": id, "slug": slug, "name": name, "description": desc,
				"is_default": def, "message_count": count, "last_message_at": last,
			})
		}
	}
	c.JSON(200, gin.H{"items": out})
}

func (h *Campfire) CreateRoom(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	var req struct {
		Slug        string `json:"slug" binding:"required,min=2"`
		Name        string `json:"name" binding:"required,min=2"`
		Description string `json:"description"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	slug := strings.ToLower(strings.TrimSpace(req.Slug))
	var id uuid.UUID
	if err := h.db.QueryRow(c.Request.Context(), `
		INSERT INTO campfire_rooms (tenant_id, slug, name, description)
		VALUES ($1,$2,$3,NULLIF($4,''))
		RETURNING id`, tid, slug, strings.TrimSpace(req.Name), strings.TrimSpace(req.Description)).Scan(&id); err != nil {
		c.JSON(409, gin.H{"error": "room already exists or invalid"})
		return
	}
	c.JSON(201, gin.H{"id": id})
}

func (h *Campfire) ListMessages(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	roomID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "bad id"})
		return
	}
	// We return newest-200 in chronological order so the UI can scroll-bottom.
	rows, err := h.db.Query(c.Request.Context(), `
		SELECT m.id, m.author_id, COALESCE(u.full_name,''), COALESCE(u.email::text,''),
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
			id                  uuid.UUID
			author              *uuid.UUID
			name, email, body   string
			created             time.Time
		)
		if err := rows.Scan(&id, &author, &name, &email, &body, &created); err == nil {
			out = append(out, gin.H{
				"id": id, "author_id": author, "author_name": name, "author_email": email,
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
	go h.dispatchMentions(context.Background(), tid, uid, req.Body, "Campfire room message", "/campfire")
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
