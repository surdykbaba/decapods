package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Huddle is the morning check-in feature: a single-call endpoint serving the
// "what do I need to do today" brief, plus a POST to record the user's mood +
// focus note (and cross-post it to Campfire on request). Idempotent per
// (user, day) — re-submitting updates the row in place.
type Huddle struct {
	db *pgxpool.Pool
}

func NewHuddle(db *pgxpool.Pool) *Huddle { return &Huddle{db: db} }

type huddleTask struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	ProjectID string  `json:"project_id"`
	Project   string  `json:"project"`
	DueOn     *string `json:"due_on"`
	Status    string  `json:"status"`
}

type huddleAttachment struct {
	Kind string `json:"kind"` // "link" | "file"
	Name string `json:"name"`
	URL  string `json:"url"`
}

type huddleResp struct {
	Today           string             `json:"today"`             // YYYY-MM-DD in server UTC
	DoneToday       bool               `json:"done_today"`
	Mood            string             `json:"mood,omitempty"`
	FocusNote       string             `json:"focus_note,omitempty"`
	YesterdayNote   string             `json:"yesterday_note,omitempty"`
	Attachments     []huddleAttachment `json:"attachments"`
	StandupAt       string             `json:"standup_at"`        // HH:MM, tenant-configurable
	TasksDueToday   []huddleTask       `json:"tasks_due_today"`
	TasksOverdue    []huddleTask       `json:"tasks_overdue"`
	ApprovalsWaiting int                `json:"approvals_waiting"`
	OnLeaveToday    bool               `json:"on_leave_today"`
}

// Get returns today's brief for the caller. Pulls the user's open tasks
// (overdue + due today), approval count, and whether they're on approved
// leave today. Also includes whether the user has already checked in for
// today so the SPA can decide whether to surface the morning sheet.
func (h *Huddle) Get(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)

	now := time.Now().UTC()
	today := now.Format("2006-01-02")

	out := huddleResp{
		Today:         today,
		StandupAt:     standupTimeFor(c.Request.Context(), h.db, tid),
		TasksDueToday: []huddleTask{},
		TasksOverdue:  []huddleTask{},
		Attachments:   []huddleAttachment{},
	}

	// Existing check-in for today?
	var (
		mood, focus, yesterday *string
		attachments            []byte
	)
	if err := h.db.QueryRow(c, `
		SELECT mood, focus_note, yesterday_note, COALESCE(attachments, '[]'::jsonb)
		  FROM daily_checkins
		 WHERE user_id=$1 AND day=$2::date`, uid, today).Scan(&mood, &focus, &yesterday, &attachments); err == nil {
		out.DoneToday = true
		if mood != nil {
			out.Mood = *mood
		}
		if focus != nil {
			out.FocusNote = *focus
		}
		if yesterday != nil {
			out.YesterdayNote = *yesterday
		}
		_ = json.Unmarshal(attachments, &out.Attachments)
	}

	// On approved leave today?
	_ = h.db.QueryRow(c, `
		SELECT EXISTS (
		  SELECT 1 FROM leave_requests
		  WHERE tenant_id=$1 AND user_id=$2 AND status='approved'
		    AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE
		)`, tid, uid).Scan(&out.OnLeaveToday)

	// Open tasks — overdue + due today, capped to a reasonable number.
	if rows, err := h.db.Query(c, `
		SELECT t.id, t.title, t.status, t.due_on, p.id, p.name
		FROM tasks t JOIN projects p ON p.id = t.project_id
		WHERE p.tenant_id=$1 AND t.assignee_id=$2
		      AND t.deleted_at IS NULL AND t.status <> 'done'
		      AND t.due_on IS NOT NULL AND t.due_on <= CURRENT_DATE
		ORDER BY t.due_on ASC LIMIT 30`, tid, uid); err == nil {
		defer rows.Close()
		for rows.Next() {
			var (
				tid, pid uuid.UUID
				title, status, pname string
				due *time.Time
			)
			if err := rows.Scan(&tid, &title, &status, &due, &pid, &pname); err != nil {
				continue
			}
			item := huddleTask{
				ID: tid.String(), Title: title, Status: status,
				ProjectID: pid.String(), Project: pname,
			}
			if due != nil {
				s := due.Format("2006-01-02")
				item.DueOn = &s
				if due.Before(now.Truncate(24 * time.Hour)) {
					out.TasksOverdue = append(out.TasksOverdue, item)
					continue
				}
			}
			out.TasksDueToday = append(out.TasksDueToday, item)
		}
	}

	// Approval count — opportunities sitting in under_review where the
	// caller's roles unlock at least one transition out. Cheap proxy until
	// we wire a richer "waiting on me" query.
	_ = h.db.QueryRow(c, `
		SELECT COUNT(*) FROM opportunities
		WHERE tenant_id=$1 AND deleted_at IS NULL AND stage='under_review'`,
		tid).Scan(&out.ApprovalsWaiting)

	c.JSON(http.StatusOK, out)
}

// Save records or updates today's check-in. Body fields are all optional;
// passing PostToCampfire=true cross-posts the focus note (and mood emoji)
// to Campfire as a "update" kind, stamping the resulting post id on the
// check-in row so the client can deep-link.
func (h *Huddle) Save(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)

	var req struct {
		Mood            string              `json:"mood"`
		FocusNote       string              `json:"focus_note"`
		YesterdayNote   string              `json:"yesterday_note"`
		Attachments     []huddleAttachment  `json:"attachments"`
		PostToCampfire  bool                `json:"post_to_campfire"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	req.Mood = strings.TrimSpace(req.Mood)
	req.FocusNote = strings.TrimSpace(req.FocusNote)
	req.YesterdayNote = strings.TrimSpace(req.YesterdayNote)
	// Defensive cap so a misbehaving client can't dump 10MB of attachments
	// into a check-in row.
	if len(req.Attachments) > 20 {
		req.Attachments = req.Attachments[:20]
	}
	attachJSON, _ := json.Marshal(req.Attachments)
	if len(attachJSON) == 0 {
		attachJSON = []byte("[]")
	}

	today := time.Now().UTC().Format("2006-01-02")

	// Optional Campfire cross-post — do this first so we can stamp the post
	// id on the check-in row. If posting fails we still save the check-in.
	var campfirePostID *uuid.UUID
	if req.PostToCampfire && req.FocusNote != "" {
		body := req.FocusNote
		if req.Mood != "" {
			body = req.Mood + " " + body
		}
		meta, _ := json.Marshal(map[string]any{
			"source": "morning_huddle",
			"mood":   req.Mood,
		})
		var pid uuid.UUID
		if err := h.db.QueryRow(c, `
			INSERT INTO campfire_posts (tenant_id, author_id, kind, title, body, meta, pinned)
			VALUES ($1,$2,'update',NULL,$3,$4,false) RETURNING id`,
			tid, uid, body, meta).Scan(&pid); err == nil {
			campfirePostID = &pid
		}
	}

	posted := campfirePostID != nil
	if _, err := h.db.Exec(c, `
		INSERT INTO daily_checkins (tenant_id, user_id, day, mood, focus_note,
		                            yesterday_note, attachments,
		                            posted_to_campfire, campfire_post_id)
		VALUES ($1,$2,$3::date, NULLIF($4,''), NULLIF($5,''),
		        NULLIF($6,''), $7::jsonb, $8, $9)
		ON CONFLICT (user_id, day) DO UPDATE SET
		  mood              = COALESCE(NULLIF(EXCLUDED.mood, ''), daily_checkins.mood),
		  focus_note        = COALESCE(NULLIF(EXCLUDED.focus_note, ''), daily_checkins.focus_note),
		  yesterday_note    = COALESCE(NULLIF(EXCLUDED.yesterday_note, ''), daily_checkins.yesterday_note),
		  attachments       = CASE
		                        WHEN jsonb_array_length(EXCLUDED.attachments) > 0
		                          THEN EXCLUDED.attachments
		                        ELSE daily_checkins.attachments
		                      END,
		  posted_to_campfire = daily_checkins.posted_to_campfire OR EXCLUDED.posted_to_campfire,
		  campfire_post_id  = COALESCE(daily_checkins.campfire_post_id, EXCLUDED.campfire_post_id)`,
		tid, uid, today, req.Mood, req.FocusNote, req.YesterdayNote, string(attachJSON), posted, campfirePostID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"ok": true,
		"campfire_post_id": campfirePostID,
	})
}

// standupTimeFor reads the tenant's morning standup time from
// tenants.settings.standup_at (HH:MM string). Falls back to "09:30" when
// unset so the brief always has a time to render.
func standupTimeFor(ctx context.Context, db *pgxpool.Pool, tid uuid.UUID) string {
	var raw []byte
	if err := db.QueryRow(ctx, `SELECT settings FROM tenants WHERE id=$1`, tid).Scan(&raw); err != nil || len(raw) == 0 {
		return "09:30"
	}
	var s map[string]any
	if err := json.Unmarshal(raw, &s); err != nil {
		return "09:30"
	}
	if v, ok := s["standup_at"].(string); ok && v != "" {
		return v
	}
	return "09:30"
}
