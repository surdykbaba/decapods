// Package digest builds and sends the Monday-7am weekly engagement
// report. For each opted-in user it aggregates the last 7 days of
// MyAccubin activity — check-in attendance, tasks worked, hours logged,
// OKR progress, kudos received, help requests — and emails a single
// HTML+text recap.
//
// The whole module is read-only against the app schema apart from the
// users.weekly_digest_last_sent_at bookkeeping column.
package digest

import (
	"context"
	"fmt"
	"html"
	"strings"
	"time"

	"github.com/decapods/pgdp/backend/internal/notifications"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Window is the lookback window. Sunday 00:00:00 → Sunday 23:59:59
// covered by `>= now() - interval '7 days'` is intentionally fuzzy so
// a late Sunday-night activity still appears in Monday's digest.
const Window = 7 * 24 * time.Hour

// Recipient is the minimum we need to address an email.
type Recipient struct {
	ID       string
	TenantID string
	Email    string
	FullName string
}

// Data is the per-user aggregate that feeds the templates.
type Data struct {
	Recipient    Recipient
	WeekStart    time.Time
	WeekEnd      time.Time
	Attendance   AttendanceStats
	Tasks        TaskStats
	Hours        HoursStats
	OKRs         []OKRRow
	Kudos        []KudosRow
	Help         HelpStats
	Projects     []ProjectRow
	TopTasksOpen []OpenTaskRow
	Headline     string // computed in BuildForUser
}

type AttendanceStats struct {
	DaysPresent    int      // distinct working days with ≥1 slot
	SlotsLogged    int      // total slot rows
	SlotsExpected  int      // 3 slots × 5 working days = 15 by default
	MissedDays     []string // weekday names with zero slots
	FirstCheckin   *time.Time
	LastCheckout   *time.Time
}

type TaskStats struct {
	Closed   int
	Opened   int
	Overdue  int
	Blocked  int
	Updated  int
}

type HoursStats struct {
	Total   float64
	Entries int
	ByDay   map[string]float64 // weekday name → hours
}

type OKRRow struct {
	Title       string
	Confidence  string
	Progress    float64 // 0-1
	Delta       float64 // pp change in last 7d
	CycleName   string
}

type KudosRow struct {
	FromName string
	Badge    string
	Message  string
}

type HelpStats struct {
	Asked    int
	Resolved int
	Helped   int
}

type ProjectRow struct {
	Code  string
	Name  string
	Hours float64
	Tasks int
}

type OpenTaskRow struct {
	Title       string
	ProjectCode string
	DueOn       *time.Time
	Status      string
}

// Sender is the orchestrator. Construct one with New, then call
// SendForUser/SendDue.
type Sender struct {
	db     *pgxpool.Pool
	mailer *notifications.Mailer
}

func New(db *pgxpool.Pool, mailer *notifications.Mailer) *Sender {
	return &Sender{db: db, mailer: mailer}
}

// SendDue picks every opted-in user whose last digest is older than 6
// days (so a Monday-morning sweep catches everyone exactly once even
// if the tick runs multiple times across the morning) and sends.
// Returns (sent, skipped, error).
func (s *Sender) SendDue(ctx context.Context, now time.Time) (sent int, skipped int, err error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, tenant_id, email, full_name
		FROM users
		WHERE weekly_digest_enabled = true
		  AND status = 'active'
		  AND deleted_at IS NULL
		  AND (weekly_digest_last_sent_at IS NULL
		       OR weekly_digest_last_sent_at < $1 - interval '6 days')
	`, now)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()

	var recipients []Recipient
	for rows.Next() {
		var r Recipient
		if err := rows.Scan(&r.ID, &r.TenantID, &r.Email, &r.FullName); err != nil {
			return sent, skipped, err
		}
		recipients = append(recipients, r)
	}
	if err := rows.Err(); err != nil {
		return sent, skipped, err
	}

	for _, r := range recipients {
		if err := s.SendForUser(ctx, r, now); err != nil {
			skipped++
			// log-and-continue is the right policy here; one user's
			// SMTP hiccup mustn't block the rest of the team.
			continue
		}
		sent++
	}
	return sent, skipped, nil
}

// SendForUser builds + sends the digest for one user and records the
// send time. Safe to call ad-hoc from an admin endpoint.
func (s *Sender) SendForUser(ctx context.Context, r Recipient, now time.Time) error {
	data, err := s.BuildForUser(ctx, r, now)
	if err != nil {
		return fmt.Errorf("build: %w", err)
	}
	email := notifications.Email{
		To:      r.Email,
		Subject: subjectFor(data),
		Plain:   renderText(data),
		HTML:    renderHTML(data),
	}
	if err := s.mailer.Send(ctx, email); err != nil {
		return fmt.Errorf("send: %w", err)
	}
	_, _ = s.db.Exec(ctx,
		`UPDATE users SET weekly_digest_last_sent_at = $1 WHERE id = $2`,
		now, r.ID,
	)
	return nil
}

// BuildForUser is exported so an admin "preview" endpoint can render
// the email without actually sending it.
func (s *Sender) BuildForUser(ctx context.Context, r Recipient, now time.Time) (Data, error) {
	weekEnd := now
	weekStart := now.Add(-Window)
	d := Data{
		Recipient: r,
		WeekStart: weekStart,
		WeekEnd:   weekEnd,
		Hours:     HoursStats{ByDay: map[string]float64{}},
	}

	// --- attendance ---
	{
		var rowsPresent int
		var slotsLogged int
		var firstAt, lastAt *time.Time
		err := s.db.QueryRow(ctx, `
			SELECT
				COUNT(DISTINCT day) FILTER (WHERE COALESCE(array_length(slots_done,1),0) > 0),
				COALESCE(SUM(COALESCE(array_length(slots_done,1),0)), 0),
				MIN((slot_times->>'morning')::timestamptz)   FILTER (WHERE slot_times ? 'morning'),
				MAX((slot_times->>'evening')::timestamptz)   FILTER (WHERE slot_times ? 'evening')
			FROM daily_checkins
			WHERE user_id = $1
			  AND day >= ($2::timestamptz)::date
		`, r.ID, weekStart).Scan(&rowsPresent, &slotsLogged, &firstAt, &lastAt)
		if err != nil {
			return d, fmt.Errorf("attendance: %w", err)
		}
		d.Attendance.DaysPresent = rowsPresent
		d.Attendance.SlotsLogged = slotsLogged
		d.Attendance.FirstCheckin = firstAt
		d.Attendance.LastCheckout = lastAt
		d.Attendance.SlotsExpected = 15 // 3 slots × 5 weekdays

		// Missed weekdays = weekdays in window that have no row.
		missedRows, err := s.db.Query(ctx, `
			SELECT to_char(gs::date, 'Dy') AS dow, gs::date AS day
			FROM generate_series($1::date, $2::date, '1 day') gs
			WHERE EXTRACT(ISODOW FROM gs) < 6
			  AND NOT EXISTS (
				SELECT 1 FROM daily_checkins dc
				WHERE dc.user_id = $3
				  AND dc.day = gs::date
				  AND COALESCE(array_length(dc.slots_done,1),0) > 0
			  )
		`, weekStart, weekEnd, r.ID)
		if err == nil {
			for missedRows.Next() {
				var dow string
				var day time.Time
				if err := missedRows.Scan(&dow, &day); err == nil {
					d.Attendance.MissedDays = append(d.Attendance.MissedDays, dow)
				}
			}
			missedRows.Close()
		}
	}

	// --- tasks ---
	err := s.db.QueryRow(ctx, `
		WITH mine AS (
			SELECT * FROM tasks
			WHERE assignee_id = $1 AND deleted_at IS NULL
		)
		SELECT
			(SELECT COUNT(*) FROM mine WHERE status = 'done'    AND updated_at >= $2),
			(SELECT COUNT(*) FROM mine WHERE created_at >= $2),
			(SELECT COUNT(*) FROM mine WHERE status NOT IN ('done','dropped') AND due_on IS NOT NULL AND due_on < CURRENT_DATE),
			(SELECT COUNT(*) FROM mine WHERE status = 'blocked'),
			(SELECT COUNT(*) FROM mine WHERE updated_at >= $2)
	`, r.ID, weekStart).Scan(
		&d.Tasks.Closed, &d.Tasks.Opened, &d.Tasks.Overdue, &d.Tasks.Blocked, &d.Tasks.Updated,
	)
	if err != nil {
		return d, fmt.Errorf("tasks: %w", err)
	}

	// --- hours by day ---
	hoursRows, err := s.db.Query(ctx, `
		SELECT to_char(work_date, 'Dy') AS dow, SUM(hours)::float8
		FROM time_entries
		WHERE user_id = $1 AND work_date >= $2::date
		GROUP BY 1
	`, r.ID, weekStart)
	if err == nil {
		for hoursRows.Next() {
			var dow string
			var h float64
			if err := hoursRows.Scan(&dow, &h); err == nil {
				d.Hours.ByDay[dow] = h
				d.Hours.Total += h
			}
		}
		hoursRows.Close()
	}
	_ = s.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM time_entries WHERE user_id = $1 AND work_date >= $2::date`,
		r.ID, weekStart,
	).Scan(&d.Hours.Entries)

	// --- top projects (by hours) ---
	projRows, err := s.db.Query(ctx, `
		SELECT p.code, p.name, COALESCE(SUM(te.hours),0)::float8 AS h,
			(SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.assignee_id = $1 AND t.updated_at >= $2) AS task_n
		FROM time_entries te
		JOIN projects p ON p.id = te.project_id
		WHERE te.user_id = $1 AND te.work_date >= $2::date
		GROUP BY p.id, p.code, p.name
		ORDER BY h DESC
		LIMIT 5
	`, r.ID, weekStart)
	if err == nil {
		for projRows.Next() {
			var row ProjectRow
			if err := projRows.Scan(&row.Code, &row.Name, &row.Hours, &row.Tasks); err == nil {
				d.Projects = append(d.Projects, row)
			}
		}
		projRows.Close()
	}

	// --- OKRs (owner = user) ---
	okrRows, err := s.db.Query(ctx, `
		SELECT o.title, o.confidence,
			CASE WHEN COALESCE(o.target_value,0) > 0
				THEN LEAST(1.0, o.current_value / o.target_value)
				ELSE 0 END AS prog,
			c.name
		FROM okrs o
		JOIN okr_cycles c ON c.id = o.cycle_id
		WHERE o.owner_id = $1
		  AND o.kind = 'objective'
		  AND c.status = 'active'
		ORDER BY o.position
		LIMIT 6
	`, r.ID)
	if err == nil {
		for okrRows.Next() {
			var row OKRRow
			if err := okrRows.Scan(&row.Title, &row.Confidence, &row.Progress, &row.CycleName); err == nil {
				d.OKRs = append(d.OKRs, row)
			}
		}
		okrRows.Close()
	}

	// --- kudos received this week ---
	kRows, err := s.db.Query(ctx, `
		SELECT COALESCE(u.full_name, u.email), k.badge, COALESCE(k.message, '')
		FROM campfire_kudos k
		JOIN users u ON u.id = k.from_user_id
		WHERE k.to_user_id = $1 AND k.created_at >= $2
		ORDER BY k.created_at DESC
		LIMIT 8
	`, r.ID, weekStart)
	if err == nil {
		for kRows.Next() {
			var row KudosRow
			if err := kRows.Scan(&row.FromName, &row.Badge, &row.Message); err == nil {
				d.Kudos = append(d.Kudos, row)
			}
		}
		kRows.Close()
	}

	// --- help wall ---
	_ = s.db.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM campfire_help WHERE requester_id = $1 AND created_at >= $2),
			(SELECT COUNT(*) FROM campfire_help WHERE requester_id = $1 AND status = 'resolved' AND resolved_at >= $2),
			(SELECT COUNT(*) FROM campfire_help WHERE resolver_id  = $1 AND resolved_at >= $2)
	`, r.ID, weekStart).Scan(&d.Help.Asked, &d.Help.Resolved, &d.Help.Helped)

	// --- top open tasks ---
	openRows, err := s.db.Query(ctx, `
		SELECT t.title, p.code, t.due_on, t.status
		FROM tasks t
		JOIN projects p ON p.id = t.project_id
		WHERE t.assignee_id = $1
		  AND t.deleted_at IS NULL
		  AND t.status NOT IN ('done','dropped')
		ORDER BY
			(t.status = 'blocked') DESC,
			(t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE) DESC,
			t.due_on NULLS LAST
		LIMIT 6
	`, r.ID)
	if err == nil {
		for openRows.Next() {
			var row OpenTaskRow
			if err := openRows.Scan(&row.Title, &row.ProjectCode, &row.DueOn, &row.Status); err == nil {
				d.TopTasksOpen = append(d.TopTasksOpen, row)
			}
		}
		openRows.Close()
	}

	d.Headline = headlineFor(d)
	return d, nil
}

func headlineFor(d Data) string {
	switch {
	case d.Attendance.DaysPresent == 0 && d.Hours.Total == 0:
		return "We didn't see you last week — everything OK?"
	case d.Tasks.Closed >= 5:
		return fmt.Sprintf("Strong week: %d tasks shipped", d.Tasks.Closed)
	case d.Tasks.Blocked > 0:
		return fmt.Sprintf("Heads up: %d task%s still blocked", d.Tasks.Blocked, plural(d.Tasks.Blocked))
	case d.Tasks.Overdue > 0:
		return fmt.Sprintf("%d task%s overdue heading into Monday", d.Tasks.Overdue, plural(d.Tasks.Overdue))
	case len(d.Kudos) > 0:
		return fmt.Sprintf("You picked up %d kudos last week 🎉", len(d.Kudos))
	default:
		return "Your week at MyAccubin"
	}
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func subjectFor(d Data) string {
	return fmt.Sprintf("[MyAccubin] %s", d.Headline)
}

// --- text + HTML rendering --------------------------------------------------
//
// Both renderers are hand-rolled (no html/template) because:
//   1. The shape is fixed; conditional branches read clearer as Go.
//   2. The HTML is intentionally inline-styled for Gmail/Outlook fidelity —
//      a template would just make the styles harder to read.

func renderText(d Data) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n", d.Headline)
	fmt.Fprintf(&b, "Week of %s – %s\n\n",
		d.WeekStart.Format("Mon 02 Jan"), d.WeekEnd.Format("Mon 02 Jan"))

	fmt.Fprintf(&b, "ATTENDANCE\n")
	fmt.Fprintf(&b, "  Days present : %d of 5\n", d.Attendance.DaysPresent)
	fmt.Fprintf(&b, "  Slots logged : %d of %d\n", d.Attendance.SlotsLogged, d.Attendance.SlotsExpected)
	if len(d.Attendance.MissedDays) > 0 {
		fmt.Fprintf(&b, "  Missed       : %s\n", strings.Join(d.Attendance.MissedDays, ", "))
	}
	if d.Attendance.FirstCheckin != nil {
		fmt.Fprintf(&b, "  First check-in : %s\n", d.Attendance.FirstCheckin.Format("Mon 15:04"))
	}
	if d.Attendance.LastCheckout != nil {
		fmt.Fprintf(&b, "  Last check-out : %s\n", d.Attendance.LastCheckout.Format("Mon 15:04"))
	}
	b.WriteString("\n")

	fmt.Fprintf(&b, "TASKS\n")
	fmt.Fprintf(&b, "  Closed    : %d\n", d.Tasks.Closed)
	fmt.Fprintf(&b, "  Opened    : %d\n", d.Tasks.Opened)
	fmt.Fprintf(&b, "  Overdue   : %d\n", d.Tasks.Overdue)
	fmt.Fprintf(&b, "  Blocked   : %d\n\n", d.Tasks.Blocked)

	fmt.Fprintf(&b, "HOURS LOGGED : %.1fh (%d entries)\n", d.Hours.Total, d.Hours.Entries)
	for _, dow := range []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"} {
		if h, ok := d.Hours.ByDay[dow]; ok && h > 0 {
			fmt.Fprintf(&b, "  %s: %.1fh\n", dow, h)
		}
	}
	b.WriteString("\n")

	if len(d.Projects) > 0 {
		fmt.Fprintf(&b, "TOP PROJECTS\n")
		for _, p := range d.Projects {
			fmt.Fprintf(&b, "  %s — %s : %.1fh, %d task updates\n", p.Code, p.Name, p.Hours, p.Tasks)
		}
		b.WriteString("\n")
	}

	if len(d.OKRs) > 0 {
		fmt.Fprintf(&b, "YOUR OKRs\n")
		for _, o := range d.OKRs {
			fmt.Fprintf(&b, "  [%s] %s — %.0f%% (%s)\n", strings.ToUpper(o.Confidence), o.Title, o.Progress*100, o.CycleName)
		}
		b.WriteString("\n")
	}

	if len(d.Kudos) > 0 {
		fmt.Fprintf(&b, "KUDOS RECEIVED\n")
		for _, k := range d.Kudos {
			fmt.Fprintf(&b, "  %s → %s", k.FromName, k.Badge)
			if k.Message != "" {
				fmt.Fprintf(&b, ": %q", k.Message)
			}
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}

	if d.Help.Asked+d.Help.Resolved+d.Help.Helped > 0 {
		fmt.Fprintf(&b, "HELP WALL : asked %d · resolved %d · helped others %d\n\n",
			d.Help.Asked, d.Help.Resolved, d.Help.Helped)
	}

	if len(d.TopTasksOpen) > 0 {
		fmt.Fprintf(&b, "OPEN TASKS HEADING INTO MONDAY\n")
		for _, t := range d.TopTasksOpen {
			due := ""
			if t.DueOn != nil {
				due = " (due " + t.DueOn.Format("Mon 02 Jan") + ")"
			}
			fmt.Fprintf(&b, "  [%s] %s — %s%s\n", strings.ToUpper(t.Status), t.ProjectCode, t.Title, due)
		}
		b.WriteString("\n")
	}

	b.WriteString("— Open MyAccubin: https://myaccubin.com/me\n")
	b.WriteString("Manage email preferences: https://myaccubin.com/me/settings\n")
	return b.String()
}

// renderHTML — single-table layout, all inline styles. Avoid external
// CSS or media queries; Gmail strips both.
func renderHTML(d Data) string {
	var b strings.Builder
	b.WriteString(`<!doctype html><html><body style="margin:0;padding:0;background:#0b1220;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#e6edf3">`)
	b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0b1220"><tr><td align="center" style="padding:24px 12px">`)
	b.WriteString(`<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;background:#0f1a2e;border:1px solid #1f2a44;border-radius:14px;overflow:hidden">`)

	// Header
	fmt.Fprintf(&b, `<tr><td style="padding:22px 24px 8px 24px">
		<div style="font-size:12px;color:#7aa2ff;letter-spacing:.18em;text-transform:uppercase;font-weight:700">MyAccubin · weekly digest</div>
		<div style="font-size:22px;font-weight:800;color:#fff;margin-top:6px;line-height:1.2">%s</div>
		<div style="font-size:13px;color:#8b9bb4;margin-top:4px">Week of %s – %s · hi %s</div>
	</td></tr>`,
		html.EscapeString(d.Headline),
		d.WeekStart.Format("Mon 02 Jan"), d.WeekEnd.Format("Mon 02 Jan"),
		html.EscapeString(firstName(d.Recipient.FullName, d.Recipient.Email)),
	)

	// At-a-glance row (attendance + tasks)
	b.WriteString(`<tr><td style="padding:8px 24px 8px 24px">`)
	b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`)
	statTile(&b, "Days present", fmt.Sprintf("%d/5", d.Attendance.DaysPresent), "#22c55e")
	statTile(&b, "Slots logged", fmt.Sprintf("%d/%d", d.Attendance.SlotsLogged, d.Attendance.SlotsExpected), "#7aa2ff")
	statTile(&b, "Tasks closed", fmt.Sprintf("%d", d.Tasks.Closed), "#22c55e")
	statTile(&b, "Hours logged", fmt.Sprintf("%.1fh", d.Hours.Total), "#a78bfa")
	b.WriteString(`</tr></table></td></tr>`)

	// Warnings strip
	if d.Tasks.Blocked > 0 || d.Tasks.Overdue > 0 || len(d.Attendance.MissedDays) > 0 {
		b.WriteString(`<tr><td style="padding:0 24px 12px 24px"><div style="padding:10px 14px;background:#3a1f1f;border:1px solid #7f2a2a;border-radius:10px;font-size:13px;color:#fbbf24">`)
		var bits []string
		if d.Tasks.Blocked > 0 {
			bits = append(bits, fmt.Sprintf("<b>%d</b> blocked task%s", d.Tasks.Blocked, plural(d.Tasks.Blocked)))
		}
		if d.Tasks.Overdue > 0 {
			bits = append(bits, fmt.Sprintf("<b>%d</b> overdue", d.Tasks.Overdue))
		}
		if len(d.Attendance.MissedDays) > 0 {
			bits = append(bits, fmt.Sprintf("missed: %s", html.EscapeString(strings.Join(d.Attendance.MissedDays, ", "))))
		}
		b.WriteString(strings.Join(bits, " · "))
		b.WriteString(`</div></td></tr>`)
	}

	// Hours by day
	if len(d.Hours.ByDay) > 0 {
		b.WriteString(`<tr><td style="padding:4px 24px 8px 24px">`)
		sectionTitle(&b, "Hours by day")
		b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`)
		for _, dow := range []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"} {
			h := d.Hours.ByDay[dow]
			cell := "—"
			if h > 0 {
				cell = fmt.Sprintf("%.1fh", h)
			}
			fmt.Fprintf(&b, `<td align="center" style="padding:8px 4px;background:#0b1220;border:1px solid #1f2a44;border-radius:8px"><div style="font-size:11px;color:#8b9bb4">%s</div><div style="font-size:14px;font-weight:700;color:#fff;margin-top:2px">%s</div></td><td style="width:6px"></td>`, dow, cell)
		}
		b.WriteString(`</tr></table></td></tr>`)
	}

	// Projects
	if len(d.Projects) > 0 {
		b.WriteString(`<tr><td style="padding:8px 24px">`)
		sectionTitle(&b, "Top projects")
		for _, p := range d.Projects {
			fmt.Fprintf(&b, `<div style="padding:10px 12px;background:#0b1220;border:1px solid #1f2a44;border-radius:10px;margin-bottom:6px">
				<div style="font-size:13.5px;font-weight:700;color:#fff"><span style="font-family:ui-monospace,Menlo,Consolas,monospace;color:#7aa2ff">%s</span> · %s</div>
				<div style="font-size:12px;color:#8b9bb4;margin-top:2px">%.1fh · %d task update%s</div>
			</div>`, html.EscapeString(p.Code), html.EscapeString(p.Name), p.Hours, p.Tasks, plural(p.Tasks))
		}
		b.WriteString(`</td></tr>`)
	}

	// OKRs
	if len(d.OKRs) > 0 {
		b.WriteString(`<tr><td style="padding:8px 24px">`)
		sectionTitle(&b, "Your objectives")
		for _, o := range d.OKRs {
			tone := confidenceColor(o.Confidence)
			pct := int(o.Progress * 100)
			fmt.Fprintf(&b, `<div style="padding:10px 12px;background:#0b1220;border:1px solid #1f2a44;border-radius:10px;margin-bottom:6px">
				<div style="font-size:13.5px;font-weight:700;color:#fff">%s</div>
				<div style="font-size:12px;color:#8b9bb4;margin-top:2px">%s · <span style="color:%s;font-weight:700">%s</span></div>
				<div style="margin-top:6px;background:#1f2a44;border-radius:99px;height:6px;overflow:hidden"><div style="width:%d%%;background:%s;height:6px"></div></div>
				<div style="font-size:11px;color:#8b9bb4;margin-top:3px">%d%% complete</div>
			</div>`, html.EscapeString(o.Title), html.EscapeString(o.CycleName), tone, strings.ToUpper(o.Confidence), pct, tone, pct)
		}
		b.WriteString(`</td></tr>`)
	}

	// Kudos
	if len(d.Kudos) > 0 {
		b.WriteString(`<tr><td style="padding:8px 24px">`)
		sectionTitle(&b, "Kudos you received")
		for _, k := range d.Kudos {
			fmt.Fprintf(&b, `<div style="padding:10px 12px;background:#1d1607;border:1px solid #5c4416;border-radius:10px;margin-bottom:6px">
				<div style="font-size:13px;color:#fbbf24"><b>%s</b> · %s</div>`, html.EscapeString(k.FromName), html.EscapeString(prettyBadge(k.Badge)))
			if k.Message != "" {
				fmt.Fprintf(&b, `<div style="font-size:12.5px;color:#e6edf3;margin-top:3px">"%s"</div>`, html.EscapeString(k.Message))
			}
			b.WriteString(`</div>`)
		}
		b.WriteString(`</td></tr>`)
	}

	// Open tasks heading into Monday
	if len(d.TopTasksOpen) > 0 {
		b.WriteString(`<tr><td style="padding:8px 24px">`)
		sectionTitle(&b, "Open tasks for the week ahead")
		for _, t := range d.TopTasksOpen {
			due := ""
			if t.DueOn != nil {
				due = " · due " + t.DueOn.Format("Mon 02 Jan")
			}
			statusBg := "#1f2a44"
			statusFg := "#8b9bb4"
			if t.Status == "blocked" {
				statusBg, statusFg = "#3a1f1f", "#fca5a5"
			} else if t.Status == "in_progress" {
				statusBg, statusFg = "#1f2a44", "#7aa2ff"
			}
			fmt.Fprintf(&b, `<div style="padding:10px 12px;background:#0b1220;border:1px solid #1f2a44;border-radius:10px;margin-bottom:6px">
				<div style="font-size:13.5px;color:#fff">%s</div>
				<div style="font-size:11.5px;margin-top:3px"><span style="font-family:ui-monospace,Menlo,Consolas,monospace;color:#7aa2ff">%s</span> · <span style="padding:1px 6px;border-radius:99px;background:%s;color:%s;font-weight:700">%s</span>%s</div>
			</div>`, html.EscapeString(t.Title), html.EscapeString(t.ProjectCode), statusBg, statusFg, html.EscapeString(strings.ToUpper(t.Status)), html.EscapeString(due))
		}
		b.WriteString(`</td></tr>`)
	}

	// Help wall summary
	if d.Help.Asked+d.Help.Resolved+d.Help.Helped > 0 {
		fmt.Fprintf(&b, `<tr><td style="padding:8px 24px">`)
		sectionTitle(&b, "Help wall")
		fmt.Fprintf(&b, `<div style="font-size:13px;color:#e6edf3">You asked <b>%d</b>, resolved <b>%d</b>, and helped teammates with <b>%d</b> request%s.</div></td></tr>`,
			d.Help.Asked, d.Help.Resolved, d.Help.Helped, plural(d.Help.Helped))
	}

	// Footer
	b.WriteString(`<tr><td style="padding:18px 24px 24px 24px;border-top:1px solid #1f2a44;margin-top:8px">
		<a href="https://myaccubin.com/me" style="display:inline-block;padding:9px 16px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:700">Open MyAccubin</a>
		<div style="font-size:11px;color:#5b6c8c;margin-top:14px">You're getting this because you opted in to the weekly digest. <a href="https://myaccubin.com/me/settings" style="color:#7aa2ff">Manage preferences</a>.</div>
	</td></tr>`)

	b.WriteString(`</table></td></tr></table></body></html>`)
	return b.String()
}

func statTile(b *strings.Builder, label, val, tone string) {
	fmt.Fprintf(b, `<td width="25%%" align="center" style="padding:0 4px">
		<div style="padding:14px 8px;background:#0b1220;border:1px solid #1f2a44;border-radius:12px">
			<div style="font-size:11px;color:#8b9bb4;letter-spacing:.06em;text-transform:uppercase;font-weight:700">%s</div>
			<div style="font-size:22px;font-weight:800;color:%s;margin-top:4px">%s</div>
		</div>
	</td>`, html.EscapeString(label), tone, html.EscapeString(val))
}

func sectionTitle(b *strings.Builder, title string) {
	fmt.Fprintf(b, `<div style="font-size:11px;color:#8b9bb4;letter-spacing:.14em;text-transform:uppercase;font-weight:700;margin:6px 0 8px 2px">%s</div>`, html.EscapeString(title))
}

func confidenceColor(c string) string {
	switch c {
	case "green":
		return "#22c55e"
	case "amber":
		return "#f59e0b"
	case "red":
		return "#ef4444"
	default:
		return "#7aa2ff"
	}
}

func prettyBadge(b string) string {
	switch b {
	case "delivery_champion":
		return "Delivery champion"
	case "problem_solver":
		return "Problem solver"
	case "team_player":
		return "Team player"
	case "fast_responder":
		return "Fast responder"
	case "client_hero":
		return "Client hero"
	default:
		return strings.Title(strings.ReplaceAll(b, "_", " "))
	}
}

func firstName(full, email string) string {
	full = strings.TrimSpace(full)
	if full != "" {
		if i := strings.Index(full, " "); i > 0 {
			return full[:i]
		}
		return full
	}
	if i := strings.Index(email, "@"); i > 0 {
		return email[:i]
	}
	return email
}
