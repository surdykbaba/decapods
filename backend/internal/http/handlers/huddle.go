package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/decapods/pgdp/backend/internal/auth"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// mustForceShareToCampfire — true when the caller has to cross-post their
// check-in into Campfire. Leadership / PMs / HR can opt in or out; everyone
// else (engineers, designers, QA, BD, finance, interns, etc.) is on the
// hook to make their plan visible to their team. PMs scan the Campfire
// feed instead of a per-team report tab — same data, surfaced where the
// conversation already lives.
func mustForceShareToCampfire(roles []string) bool {
	for _, r := range roles {
		switch r {
		case "super_admin", "ceo", "coo", "hr", "hr_manager",
			"delivery_manager", "project_manager":
			return false
		}
	}
	// governance:write or workforce:write also covers leadership-style
	// roles we may add later; if either passes, opt-out is allowed.
	if auth.HasPermission(roles, "governance:write") || auth.HasPermission(roles, "workforce:write") {
		return false
	}
	return true
}

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
	// YesterdayPlan — the user's most-recent *prior* check-in focus_note.
	// Today's "Yesterday" textarea pre-fills with this so we don't ask
	// "what did you do yesterday?" when we already know the plan they
	// committed to. The user can still edit it before saving.
	YesterdayPlan   string             `json:"yesterday_plan,omitempty"`
	// YesterdayPlanDay — the source day for YesterdayPlan (YYYY-MM-DD).
	// May not literally be "yesterday" — Monday's check-in often pulls
	// from Friday because there's no weekend check-in to read.
	YesterdayPlanDay string            `json:"yesterday_plan_day,omitempty"`
	Attachments     []huddleAttachment `json:"attachments"`
	// SlotsDone — which of the three daily check-in slots (morning,
	// afternoon, evening) the caller has filled today. The SPA uses this
	// to disable the slot button once used and to render the "did /
	// missed / open" pill row.
	SlotsDone       []string           `json:"slots_done"`
	// SlotTimes is a {slot_key: iso8601-timestamp} map so the SPA can
	// render "Checked in at 09:32" / "Checked out at 18:11" instead of
	// just "Checked in". Empty until the user logs at least one slot
	// post-migration 000059.
	SlotTimes       map[string]any     `json:"slot_times"`
	StandupAt       string             `json:"standup_at"`        // HH:MM, tenant-configurable
	// Standup card "live" window — the SPA uses these to decide whether to
	// render the nudge + late-status buttons or just a quiet "next standup
	// at HH:MM" hint. Settable by admins on the Settings → Standup page.
	StandupWindowBeforeMin int             `json:"standup_window_before_min"`
	StandupWindowAfterMin  int             `json:"standup_window_after_min"`
	TasksDueToday   []huddleTask       `json:"tasks_due_today"`
	TasksOverdue    []huddleTask       `json:"tasks_overdue"`
	ApprovalsWaiting int                `json:"approvals_waiting"`
	OnLeaveToday    bool               `json:"on_leave_today"`
	// ForceShareToCampfire — server's verdict on whether this caller can
	// opt out of cross-posting their check-in to the Campfire feed. true
	// for individual-contributor roles (engineer / designer / qa / bd /
	// finance / intern); false for leadership + PM + HR. SPA renders the
	// toggle as locked + checked when true.
	ForceShareToCampfire bool              `json:"force_share_to_campfire"`
}

// validCheckinSlot — the three accepted slot strings. Anything else is
// treated as "no slot" (legacy clients) so we don't reject those POSTs.
func validCheckinSlot(s string) bool {
	return s == "morning" || s == "afternoon" || s == "evening"
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

	winBefore, winAfter := loadStandupWindows(c, h.db, tid)
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	out := huddleResp{
		Today:                  today,
		StandupAt:              standupTimeFor(c.Request.Context(), h.db, tid),
		StandupWindowBeforeMin: winBefore,
		StandupWindowAfterMin:  winAfter,
		TasksDueToday:          []huddleTask{},
		TasksOverdue:           []huddleTask{},
		Attachments:            []huddleAttachment{},
		SlotsDone:              []string{},
		SlotTimes:              map[string]any{},
		ForceShareToCampfire:   mustForceShareToCampfire(roles),
	}

	// Existing check-in for today?
	var (
		mood, focus, yesterday *string
		attachments            []byte
		slotsDone              []string
		slotTimes              []byte
	)
	if err := h.db.QueryRow(c, `
		SELECT mood, focus_note, yesterday_note, COALESCE(attachments, '[]'::jsonb),
		       COALESCE(slots_done, '{}'), COALESCE(slot_times, '{}'::jsonb)
		  FROM daily_checkins
		 WHERE user_id=$1 AND day=$2::date`, uid, today).Scan(&mood, &focus, &yesterday, &attachments, &slotsDone, &slotTimes); err == nil {
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
		if slotsDone != nil {
			out.SlotsDone = slotsDone
		}
		if len(slotTimes) > 0 {
			_ = json.Unmarshal(slotTimes, &out.SlotTimes)
		}
	}

	// Pull the most recent prior focus_note within the last 14 days so the
	// SPA can pre-fill the "Yesterday" field instead of asking the user to
	// retype what they already committed to. Skips weekend gaps automatically
	// because we order by day DESC and look for any prior row with content.
	var (
		priorPlan *string
		priorDay  *time.Time
	)
	_ = h.db.QueryRow(c, `
		SELECT focus_note, day FROM daily_checkins
		 WHERE user_id=$1 AND day < $2::date AND day >= ($2::date - INTERVAL '14 days')
		   AND focus_note IS NOT NULL AND length(trim(focus_note)) > 0
		 ORDER BY day DESC
		 LIMIT 1`, uid, today).Scan(&priorPlan, &priorDay)
	if priorPlan != nil && priorDay != nil {
		out.YesterdayPlan = *priorPlan
		out.YesterdayPlanDay = priorDay.Format("2006-01-02")
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
		// Optional. YYYY-MM-DD. Defaults to today. Allowed range is the
		// last 14 days so a user can recall + flesh out a recent check-in
		// they rushed through, but can't fabricate ancient history.
		Day             string              `json:"day"`
		// Optional. "morning" | "afternoon" | "evening". When provided we
		// enforce the "three times per day, can't repeat a slot" rule —
		// re-saving the same slot returns 409. Legacy clients that omit
		// this field still work and update the row without slot tracking.
		Slot            string              `json:"slot"`
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
	if req.Day = strings.TrimSpace(req.Day); req.Day == "" {
		req.Day = today
	} else {
		// Sanity-check the date and clamp to the 14-day window.
		d, err := time.Parse("2006-01-02", req.Day)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "day must be YYYY-MM-DD"})
			return
		}
		age := time.Since(d.UTC())
		if age < -24*time.Hour {
			c.JSON(http.StatusBadRequest, gin.H{"error": "day cannot be in the future"})
			return
		}
		if age > 14*24*time.Hour {
			c.JSON(http.StatusBadRequest, gin.H{"error": "day is more than 14 days old — past that, ask HR"})
			return
		}
	}
	day := req.Day
	req.Slot = strings.TrimSpace(req.Slot)
	// Normalise empty / unknown slot strings to "" (legacy mode). Only the
	// three named slots feed the dedupe + slots_done tracking.
	if !validCheckinSlot(req.Slot) {
		req.Slot = ""
	}

	// Enforce one save per slot per day. If the same slot has already been
	// logged today, refuse the save and surface the current slots_done set
	// so the SPA can flip the UI without a second round-trip.
	if req.Slot != "" {
		var existing []string
		_ = h.db.QueryRow(c, `
			SELECT COALESCE(slots_done, '{}') FROM daily_checkins
			 WHERE user_id=$1 AND day=$2::date`, uid, day).Scan(&existing)
		for _, s := range existing {
			if s == req.Slot {
				c.JSON(http.StatusConflict, gin.H{
					"error":      "this slot is already logged for today",
					"code":       "slot_already_done",
					"slot":       req.Slot,
					"slots_done": existing,
				})
				return
			}
		}
	}

	// Server-side enforcement: ICs (engineer / designer / qa / etc.) can't
	// uncheck "post to Campfire". The toggle on the client may be cosmetic
	// only — even a malicious client posting post_to_campfire=false gets
	// flipped to true here. Leadership / PM / HR retain the opt-out.
	rolesAny, _ := c.Get(mw.CtxRoles)
	roles, _ := rolesAny.([]string)
	if mustForceShareToCampfire(roles) && req.FocusNote != "" {
		req.PostToCampfire = true
	}

	// Cross-posts to Campfire are only sensible for today's check-in.
	// Back-filling a yesterday entry shouldn't blast the team an "update".
	postableToCampfire := req.PostToCampfire && day == today

	// Optional Campfire cross-post — do this first so we can stamp the post
	// id on the check-in row. If posting fails we still save the check-in.
	var campfirePostID *uuid.UUID
	if postableToCampfire && req.FocusNote != "" {
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
	// Slot append: if a valid slot was given, seed slots_done with it on
	// INSERT and union it in on UPDATE. The slot-already-done conflict
	// case was rejected above, so by the time we get here the slot is
	// guaranteed to be additive.
	slotsSeed := "{}"
	slotTimesSeed := "{}"
	if req.Slot != "" {
		slotsSeed = "{" + req.Slot + "}"
		// jsonb_build_object('morning', now()) at SQL level would be
		// cleaner but the surrounding query bundles slot_times as a
		// parameter so the existing pattern stays intact.
		nowISO := time.Now().UTC().Format(time.RFC3339)
		slotTimesSeed = `{"` + req.Slot + `":"` + nowISO + `"}`
	}
	if _, err := h.db.Exec(c, `
		INSERT INTO daily_checkins (tenant_id, user_id, day, mood, focus_note,
		                            yesterday_note, attachments,
		                            posted_to_campfire, campfire_post_id, slots_done, slot_times)
		VALUES ($1,$2,$3::date, NULLIF($4,''), NULLIF($5,''),
		        NULLIF($6,''), $7::jsonb, $8, $9, $10::text[], $11::jsonb)
		ON CONFLICT (user_id, day) DO UPDATE SET
		  mood              = COALESCE(NULLIF(EXCLUDED.mood, ''), daily_checkins.mood),
		  focus_note        = COALESCE(NULLIF(EXCLUDED.focus_note, ''), daily_checkins.focus_note),
		  yesterday_note    = COALESCE(NULLIF(EXCLUDED.yesterday_note, ''), daily_checkins.yesterday_note),
		  attachments       = CASE
		                        WHEN jsonb_array_length(EXCLUDED.attachments) > 0
		                          THEN EXCLUDED.attachments
		                        ELSE daily_checkins.attachments
		                      END,
		  slots_done        = CASE
		                        WHEN array_length(EXCLUDED.slots_done, 1) IS NOT NULL
		                          THEN (SELECT ARRAY(SELECT DISTINCT unnest(daily_checkins.slots_done || EXCLUDED.slots_done)))
		                        ELSE daily_checkins.slots_done
		                      END,
		  -- Merge slot_times: existing entries kept (so an early
		  -- re-save of the same slot doesn't overwrite the original
		  -- stamp), new slot key added with its timestamp.
		  slot_times        = COALESCE(daily_checkins.slot_times, '{}'::jsonb) || EXCLUDED.slot_times,
		  posted_to_campfire = daily_checkins.posted_to_campfire OR EXCLUDED.posted_to_campfire,
		  campfire_post_id  = COALESCE(daily_checkins.campfire_post_id, EXCLUDED.campfire_post_id)`,
		tid, uid, day, req.Mood, req.FocusNote, req.YesterdayNote, string(attachJSON), posted, campfirePostID, slotsSeed, slotTimesSeed); err != nil {
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
