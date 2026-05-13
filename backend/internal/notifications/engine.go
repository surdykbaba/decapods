package notifications

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/decapods/pgdp/backend/internal/platform/config"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Tier governs *when* a recipient receives a notification.
type Tier string

const (
	TierImmediate    Tier = "immediate"
	TierDigestDaily  Tier = "digest_daily"
	TierDigestWeekly Tier = "digest_weekly"
	TierOff          Tier = "off"
)

// Category groups events for preference management. Users set tier per category,
// not per individual event — keeps the preferences UI manageable.
type Category string

const (
	CatAccount    Category = "account"
	CatPipeline   Category = "pipeline"
	CatDelivery   Category = "delivery"
	CatTasks      Category = "tasks"
	CatGovernance Category = "governance"
	CatRisk       Category = "risk"
	CatFinance    Category = "finance"
	CatVendor     Category = "vendor"
	CatRelations  Category = "relations"
	CatExecDigest Category = "exec_digest"
	// CatCampfire groups social-side events (comments / reactions / kudos
	// on the workspace pulse feed). Users typically want these immediate,
	// but quieter than task / governance — they're recognition + chatter.
	CatCampfire   Category = "campfire"
)

// EventKind is a stable, dotted identifier for a notification event. New
// events are added to the catalog below — call sites just reference the kind.
type EventKind string

// EventMeta describes a single event type. All event kinds the app fires are
// declared here, end-to-end. Wiring a new email is two steps: pick a kind from
// here, call engine.Notify(...).
type EventMeta struct {
	Kind         EventKind
	Category     Category
	DefaultTier  Tier   // baseline cadence (overridable per user)
	Severity     string // "info" | "warn" | "critical" — surfaced in templates
	SubjectTpl   string // Go text/template syntax (no Sprig); fields from payload
	HeadlineTpl  string // one-line summary used in digests
	DefaultLink  string // optional default link template (overridable in Notify)
	Description  string // human description for the preferences UI
}

// Catalog is the registry of every notification event the app can send. Add to
// this list, then call sites just reference Catalog[kind] when calling Notify.
var Catalog = map[EventKind]EventMeta{
	// 1. Account & Access
	"account.invited":           {Category: CatAccount, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "You're invited to {{.Workspace}}",                  HeadlineTpl: "Invited to {{.Workspace}}",                          Description: "You receive an invite to a workspace"},
	"account.activated":         {Category: CatAccount, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "Your account on {{.Workspace}} is active",          HeadlineTpl: "Account activated",                                  Description: "Your account is fully provisioned"},
	"account.password_reset":    {Category: CatAccount, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "Your password was reset",                            HeadlineTpl: "Password reset issued",                              Description: "An admin issued a fresh password"},
	"account.mfa_changed":       {Category: CatAccount, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "Two-factor was {{.Action}} on your account",         HeadlineTpl: "MFA {{.Action}}",                                    Description: "MFA was enabled or disabled on your account"},
	"account.removed_from_project": {Category: CatAccount, DefaultTier: TierDigestDaily, Severity: "info", SubjectTpl: "You were removed from {{.Project}}",                HeadlineTpl: "Removed from {{.Project}}",                          Description: "You were removed from a project team"},

	// 2. Pipeline / Opportunity
	"opportunity.submitted":          {Category: CatPipeline, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "Review needed — {{.Title}}",            HeadlineTpl: "{{.Title}} submitted for review",         Description: "An opportunity was submitted for review"},
	"opportunity.review_requested":   {Category: CatPipeline, DefaultTier: TierImmediate, Severity: "warn",     SubjectTpl: "Action needed — {{.Title}}",            HeadlineTpl: "Review pending on {{.Title}}",            Description: "An opportunity needs your approval"},
	"opportunity.docs_missing":       {Category: CatPipeline, DefaultTier: TierImmediate, Severity: "warn",     SubjectTpl: "Documents required — {{.Title}}",       HeadlineTpl: "Documents missing on {{.Title}}",         Description: "An opportunity is missing required documents"},
	"opportunity.approved":           {Category: CatPipeline, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "Approved — {{.Title}}",                 HeadlineTpl: "{{.Title}} approved",                     Description: "Your opportunity was approved"},
	"opportunity.rejected":           {Category: CatPipeline, DefaultTier: TierImmediate, Severity: "warn",     SubjectTpl: "Sent back — {{.Title}}",                HeadlineTpl: "{{.Title}} sent back",                    Description: "Your opportunity was sent back for changes"},
	"opportunity.converted":          {Category: CatPipeline, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "{{.Title}} is now a project",           HeadlineTpl: "{{.Title}} converted to project",         Description: "An opportunity was converted to a project"},
	"opportunity.contracting_delay":  {Category: CatPipeline, DefaultTier: TierDigestDaily, Severity: "warn",   SubjectTpl: "Contracting overdue — {{.Title}}",      HeadlineTpl: "{{.Title}} stuck in contracting",         Description: "Contracting stage is taking longer than expected"},

	// 3. Project Delivery
	"project.assigned":         {Category: CatDelivery, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "You're on {{.Project}}",                              HeadlineTpl: "Assigned to {{.Project}}",                            Description: "You were added to a project team"},
	"project.pm_assigned":      {Category: CatDelivery, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "You're managing {{.Project}}",                        HeadlineTpl: "PM on {{.Project}}",                                  Description: "You were assigned as project manager"},
	"milestone.created":        {Category: CatDelivery, DefaultTier: TierDigestDaily, Severity: "info",   SubjectTpl: "New milestone — {{.Project}}",                        HeadlineTpl: "Milestone {{.Title}} added to {{.Project}}",          Description: "A milestone was created"},
	"milestone.updated":        {Category: CatDelivery, DefaultTier: TierDigestDaily, Severity: "info",   SubjectTpl: "Milestone updated — {{.Project}}",                    HeadlineTpl: "Milestone {{.Title}} updated",                        Description: "A milestone was updated"},
	"milestone.due_soon":       {Category: CatDelivery, DefaultTier: TierImmediate, Severity: "warn",     SubjectTpl: "Milestone due soon — {{.Title}}",                     HeadlineTpl: "{{.Title}} due in {{.DaysLeft}}d",                    Description: "A milestone is due in 3 days"},
	"milestone.overdue":        {Category: CatDelivery, DefaultTier: TierImmediate, Severity: "critical", SubjectTpl: "Milestone overdue — {{.Title}}",                      HeadlineTpl: "{{.Title}} overdue",                                  Description: "A milestone is past its due date"},
	"project.status_changed":   {Category: CatDelivery, DefaultTier: TierDigestDaily, Severity: "info",   SubjectTpl: "{{.Project}} → {{.Status}}",                          HeadlineTpl: "{{.Project}} now {{.Status}}",                        Description: "A project status changed"},
	"project.qa_review":        {Category: CatDelivery, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "QA review — {{.Project}}",                            HeadlineTpl: "{{.Project}} ready for QA",                           Description: "A project moved to QA review"},
	"project.client_acceptance": {Category: CatDelivery, DefaultTier: TierImmediate, Severity: "warn",    SubjectTpl: "Client sign-off — {{.Project}}",                      HeadlineTpl: "{{.Project}} awaiting client",                        Description: "Client acceptance is required"},
	"project.closed":           {Category: CatDelivery, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "{{.Project}} closed",                                 HeadlineTpl: "{{.Project}} closed",                                 Description: "A project was closed"},

	// 4. Tasks & Team Member Work
	"task.assigned":            {Category: CatTasks, DefaultTier: TierImmediate,    Severity: "info",     SubjectTpl: "Task assigned — {{.Title}}",                          HeadlineTpl: "Task {{.Title}} assigned to you",                     Description: "A task was assigned to you"},
	"task.due_soon":            {Category: CatTasks, DefaultTier: TierImmediate,    Severity: "warn",     SubjectTpl: "Task due soon — {{.Title}}",                          HeadlineTpl: "{{.Title}} due in {{.DaysLeft}}d",                    Description: "One of your tasks is due soon"},
	"task.overdue":             {Category: CatTasks, DefaultTier: TierImmediate,    Severity: "critical", SubjectTpl: "Task overdue — {{.Title}}",                           HeadlineTpl: "{{.Title}} is overdue",                               Description: "One of your tasks is overdue"},
	"task.blocked":             {Category: CatTasks, DefaultTier: TierImmediate,    Severity: "warn",     SubjectTpl: "Blocker on {{.Title}}",                               HeadlineTpl: "{{.Title}} blocked",                                  Description: "A task is blocked"},
	"task.comment_mention":     {Category: CatTasks, DefaultTier: TierImmediate,    Severity: "info",     SubjectTpl: "{{.Author}} mentioned you on {{.Title}}",             HeadlineTpl: "Mentioned by {{.Author}} on {{.Title}}",              Description: "You were mentioned in a task comment"},
	"task.evidence_uploaded":   {Category: CatTasks, DefaultTier: TierDigestDaily,  Severity: "info",     SubjectTpl: "Evidence uploaded on {{.Title}}",                     HeadlineTpl: "Evidence on {{.Title}}",                              Description: "Evidence was uploaded against a task"},
	"task.review_requested":    {Category: CatTasks, DefaultTier: TierImmediate,    Severity: "info",     SubjectTpl: "Review needed on {{.Title}}",                         HeadlineTpl: "{{.Title}} ready for review",                         Description: "A task was submitted for review"},
	"task.approved":            {Category: CatTasks, DefaultTier: TierImmediate,    Severity: "info",     SubjectTpl: "Approved — {{.Title}}",                               HeadlineTpl: "{{.Title}} approved",                                 Description: "Your task was approved"},
	"task.rejected":            {Category: CatTasks, DefaultTier: TierImmediate,    Severity: "warn",     SubjectTpl: "Changes requested — {{.Title}}",                      HeadlineTpl: "{{.Title}} sent back",                                Description: "Your task needs changes"},

	// 5. Governance & Compliance
	"governance.docs_missing":     {Category: CatGovernance, DefaultTier: TierImmediate,   Severity: "warn",     SubjectTpl: "Document missing — {{.What}}",                HeadlineTpl: "{{.What}} missing on {{.Entity}}",          Description: "An NDA / SLA / contract is missing"},
	"governance.approval_required": {Category: CatGovernance, DefaultTier: TierImmediate,  Severity: "warn",     SubjectTpl: "Approval required — {{.Title}}",              HeadlineTpl: "Approval needed on {{.Title}}",             Description: "An approval is waiting on you"},
	"governance.approval_granted": {Category: CatGovernance, DefaultTier: TierImmediate,   Severity: "info",     SubjectTpl: "Approved — {{.Title}}",                       HeadlineTpl: "{{.Title}} approved by {{.Actor}}",         Description: "An approval was granted"},
	"governance.approval_rejected": {Category: CatGovernance, DefaultTier: TierImmediate,  Severity: "warn",     SubjectTpl: "Rejected — {{.Title}}",                       HeadlineTpl: "{{.Title}} rejected by {{.Actor}}",         Description: "An approval was rejected"},
	"governance.checkpoint_failed": {Category: CatGovernance, DefaultTier: TierImmediate,  Severity: "critical", SubjectTpl: "Checkpoint failed — {{.Title}}",              HeadlineTpl: "Checkpoint failed on {{.Title}}",           Description: "A governance checkpoint failed"},
	"governance.doc_expired":      {Category: CatGovernance, DefaultTier: TierImmediate,   Severity: "warn",     SubjectTpl: "Document expired — {{.What}}",                HeadlineTpl: "{{.What}} expired on {{.Entity}}",          Description: "A compliance document expired"},
	"governance.security_review":  {Category: CatGovernance, DefaultTier: TierImmediate,   Severity: "warn",     SubjectTpl: "Security review — {{.Title}}",                HeadlineTpl: "Security review on {{.Title}}",             Description: "A security review is required"},
	"governance.client_pending":   {Category: CatGovernance, DefaultTier: TierDigestDaily, Severity: "warn",     SubjectTpl: "Client approval pending — {{.Title}}",        HeadlineTpl: "{{.Title}} awaiting client",                Description: "Client approval is outstanding"},

	// Leave — approval flow + decision feedback. The requester gets notified
	// when their request lands a decision; approvers get notified when a
	// request reaches their stage.
	"leave.submitted":         {Category: CatGovernance, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "Leave request — {{.Requester}}",                HeadlineTpl: "{{.Requester}} requested {{.Days}}d {{.Type}}", Description: "A team member submitted a leave request", DefaultLink: "/leave"},
	"leave.approval_needed":   {Category: CatGovernance, DefaultTier: TierImmediate, Severity: "warn",     SubjectTpl: "Action needed — leave for {{.Requester}}",      HeadlineTpl: "Approve leave for {{.Requester}}",              Description: "A leave request is waiting on you", DefaultLink: "/leave"},
	"leave.approved":          {Category: CatGovernance, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "Leave approved — {{.Start}} to {{.End}}",       HeadlineTpl: "Leave approved for {{.Start}} → {{.End}}",     Description: "Your leave request was approved", DefaultLink: "/leave"},
	"leave.rejected":          {Category: CatGovernance, DefaultTier: TierImmediate, Severity: "warn",     SubjectTpl: "Leave declined — {{.Start}} to {{.End}}",       HeadlineTpl: "Leave declined: {{.Reason}}",                   Description: "Your leave request was rejected", DefaultLink: "/leave"},
	"leave.cancelled":         {Category: CatGovernance, DefaultTier: TierDigestDaily, Severity: "info",   SubjectTpl: "Leave cancelled — {{.Requester}}",              HeadlineTpl: "{{.Requester}} cancelled their leave",          Description: "A leave request was cancelled", DefaultLink: "/leave"},

	// Attendance — heartbeat-derived warnings dispatched to HR-class roles
	// when a member's away gap exceeds the threshold during work hours.
	"attendance.long_away":    {Category: CatGovernance, DefaultTier: TierImmediate, Severity: "warn",     SubjectTpl: "Attendance warning — {{.Member}}",              HeadlineTpl: "{{.Member}} was away {{.Gap}} min during work hours", Description: "A staff member was away beyond the allowed threshold during work hours", DefaultLink: "/attendance"},

	// 6. Risk & Escalation
	"risk.raised":           {Category: CatRisk, DefaultTier: TierImmediate, Severity: "warn",     SubjectTpl: "New risk — {{.Title}}",                            HeadlineTpl: "Risk raised on {{.Project}}",            Description: "A new risk was raised"},
	"risk.high_project":     {Category: CatRisk, DefaultTier: TierImmediate, Severity: "critical", SubjectTpl: "High-risk project — {{.Project}}",                 HeadlineTpl: "{{.Project}} graded high risk",          Description: "A project was graded high risk"},
	"risk.escalated":        {Category: CatRisk, DefaultTier: TierImmediate, Severity: "critical", SubjectTpl: "Escalation — {{.Title}}",                          HeadlineTpl: "Risk escalated on {{.Project}}",         Description: "A risk was escalated"},
	"risk.blocker_unresolved": {Category: CatRisk, DefaultTier: TierImmediate, Severity: "warn",   SubjectTpl: "Blocker unresolved — {{.Title}}",                  HeadlineTpl: "{{.Title}} blocked {{.Days}}d",          Description: "A blocker is unresolved past threshold"},
	"risk.sla_breach_warn":  {Category: CatRisk, DefaultTier: TierImmediate, Severity: "warn",     SubjectTpl: "SLA breach warning — {{.Title}}",                  HeadlineTpl: "SLA at risk on {{.Title}}",              Description: "An SLA is about to breach"},
	"risk.critical_assigned": {Category: CatRisk, DefaultTier: TierImmediate, Severity: "critical", SubjectTpl: "Critical issue — {{.Title}}",                    HeadlineTpl: "Critical issue on {{.Project}}",         Description: "A critical issue was assigned"},
	"risk.mitigation_overdue": {Category: CatRisk, DefaultTier: TierImmediate, Severity: "warn",   SubjectTpl: "Mitigation overdue — {{.Title}}",                  HeadlineTpl: "Mitigation overdue on {{.Title}}",       Description: "Risk mitigation is past due"},

	// 7. Finance
	"finance.invoice_created":     {Category: CatFinance, DefaultTier: TierImmediate,   Severity: "info",     SubjectTpl: "Invoice {{.Number}} created",                   HeadlineTpl: "Invoice {{.Number}} drafted",            Description: "A new invoice was created"},
	"finance.invoice_approved":    {Category: CatFinance, DefaultTier: TierImmediate,   Severity: "info",     SubjectTpl: "Invoice {{.Number}} approved",                  HeadlineTpl: "Invoice {{.Number}} approved",           Description: "An invoice was approved"},
	"finance.invoice_overdue":     {Category: CatFinance, DefaultTier: TierImmediate,   Severity: "warn",     SubjectTpl: "Overdue — {{.Number}}",                         HeadlineTpl: "Invoice {{.Number}} is overdue",         Description: "An invoice is overdue"},
	"finance.payment_logged":      {Category: CatFinance, DefaultTier: TierImmediate,   Severity: "info",     SubjectTpl: "Payment received — {{.Number}}",                HeadlineTpl: "Payment on {{.Number}}",                 Description: "A payment was logged"},
	"finance.outstanding_reminder": {Category: CatFinance, DefaultTier: TierDigestDaily, Severity: "warn",    SubjectTpl: "Outstanding balance reminder",                  HeadlineTpl: "{{.Total}} outstanding",                 Description: "Reminder of outstanding balances"},
	"finance.milestone_billed":    {Category: CatFinance, DefaultTier: TierImmediate,   Severity: "info",     SubjectTpl: "Billing triggered — {{.Title}}",                HeadlineTpl: "Milestone billing on {{.Project}}",      Description: "A milestone triggered billing"},
	"finance.budget_threshold":    {Category: CatFinance, DefaultTier: TierImmediate,   Severity: "warn",     SubjectTpl: "Budget threshold — {{.Project}}",               HeadlineTpl: "{{.Project}} at {{.Pct}}% of budget",    Description: "A project crossed a budget threshold"},
	"finance.profitability_warn":  {Category: CatFinance, DefaultTier: TierImmediate,   Severity: "warn",     SubjectTpl: "Profitability warning — {{.Project}}",          HeadlineTpl: "Margin slipping on {{.Project}}",        Description: "A project's margin is slipping"},

	// 8. Vendor / Outsourced Delivery
	"vendor.onboarded":           {Category: CatVendor, DefaultTier: TierImmediate,   Severity: "info",     SubjectTpl: "Vendor onboarded — {{.Vendor}}",                  HeadlineTpl: "{{.Vendor}} onboarded",                   Description: "A vendor was fully onboarded"},
	"vendor.docs_missing":        {Category: CatVendor, DefaultTier: TierImmediate,   Severity: "warn",     SubjectTpl: "Vendor docs missing — {{.Vendor}}",               HeadlineTpl: "{{.Vendor}} missing docs",                Description: "A vendor is missing mandatory documents"},
	"vendor.assigned":            {Category: CatVendor, DefaultTier: TierImmediate,   Severity: "info",     SubjectTpl: "Vendor assigned — {{.Vendor}}",                   HeadlineTpl: "{{.Vendor}} assigned to {{.Project}}",    Description: "A vendor was assigned to a project"},
	"vendor.deliverable_submitted": {Category: CatVendor, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "Deliverable submitted — {{.Title}}",              HeadlineTpl: "Deliverable {{.Title}}",                  Description: "A deliverable was submitted"},
	"vendor.deliverable_approved": {Category: CatVendor, DefaultTier: TierImmediate,  Severity: "info",     SubjectTpl: "Deliverable approved — {{.Title}}",               HeadlineTpl: "{{.Title}} approved",                     Description: "A deliverable was approved"},
	"vendor.deliverable_rejected": {Category: CatVendor, DefaultTier: TierImmediate,  Severity: "warn",     SubjectTpl: "Deliverable rejected — {{.Title}}",               HeadlineTpl: "{{.Title}} sent back",                    Description: "A deliverable was rejected"},
	"vendor.invoice_submitted":   {Category: CatVendor, DefaultTier: TierImmediate,   Severity: "info",     SubjectTpl: "Vendor invoice — {{.Vendor}}",                    HeadlineTpl: "Invoice from {{.Vendor}}",                Description: "A vendor submitted an invoice"},
	"vendor.compliance_issue":    {Category: CatVendor, DefaultTier: TierImmediate,   Severity: "warn",     SubjectTpl: "Vendor compliance — {{.Vendor}}",                 HeadlineTpl: "Compliance issue on {{.Vendor}}",         Description: "A vendor has a compliance issue"},

	// 9. Relationship & Engagement
	"relations.engagement_created":  {Category: CatRelations, DefaultTier: TierImmediate, Severity: "info",     SubjectTpl: "Engagement created — {{.Agent}}",            HeadlineTpl: "Engagement with {{.Agent}}",          Description: "An agent engagement was created"},
	"relations.docs_missing":        {Category: CatRelations, DefaultTier: TierImmediate, Severity: "warn",     SubjectTpl: "Agent docs missing — {{.Agent}}",            HeadlineTpl: "Agent {{.Agent}} missing docs",       Description: "An agent has missing compliance docs"},
	"relations.intro_logged":        {Category: CatRelations, DefaultTier: TierDigestDaily, Severity: "info",   SubjectTpl: "Intro logged — {{.Target}}",                 HeadlineTpl: "Intro to {{.Target}} via {{.Agent}}", Description: "An introduction was logged"},
	"relations.followup_due":        {Category: CatRelations, DefaultTier: TierImmediate, Severity: "warn",     SubjectTpl: "Follow-up due — {{.Target}}",                HeadlineTpl: "Follow up with {{.Target}}",          Description: "A follow-up is due"},
	"relations.success_fee_approval": {Category: CatRelations, DefaultTier: TierImmediate, Severity: "warn",    SubjectTpl: "Success fee approval — {{.Agent}}",          HeadlineTpl: "Success fee on {{.Agent}}",           Description: "A success fee needs approval"},
	"relations.high_risk":           {Category: CatRelations, DefaultTier: TierImmediate, Severity: "critical", SubjectTpl: "High-risk relationship — {{.Agent}}",        HeadlineTpl: "{{.Agent}} flagged high risk",        Description: "A relationship was flagged high risk"},
	"relations.commission_approval": {Category: CatRelations, DefaultTier: TierImmediate, Severity: "warn",     SubjectTpl: "Commission approval — {{.Agent}}",           HeadlineTpl: "Commission on {{.Agent}}",            Description: "A commission needs approval"},

	// 10. Executive digest events — always tier=DigestWeekly
	"exec.daily_risk":          {Category: CatExecDigest, DefaultTier: TierDigestDaily,  Severity: "info", SubjectTpl: "Daily project risk summary",          HeadlineTpl: "Daily risk summary",         Description: "Daily roll-up of project risks"},
	"exec.weekly_delivery":     {Category: CatExecDigest, DefaultTier: TierDigestWeekly, Severity: "info", SubjectTpl: "Weekly delivery portfolio",           HeadlineTpl: "Weekly delivery report",     Description: "Weekly delivery portfolio digest"},
	"exec.weekly_finance":      {Category: CatExecDigest, DefaultTier: TierDigestWeekly, Severity: "info", SubjectTpl: "Weekly finance exposure",             HeadlineTpl: "Weekly finance digest",      Description: "Weekly finance exposure digest"},
	"exec.weekly_workforce":    {Category: CatExecDigest, DefaultTier: TierDigestWeekly, Severity: "info", SubjectTpl: "Weekly workforce capacity",           HeadlineTpl: "Weekly workforce digest",    Description: "Weekly workforce capacity digest"},
	"exec.monthly_governance":  {Category: CatExecDigest, DefaultTier: TierDigestWeekly, Severity: "info", SubjectTpl: "Monthly governance compliance",       HeadlineTpl: "Monthly governance report",  Description: "Monthly compliance digest"},
}

func init() {
	// Backfill the Kind field on every catalog entry so Catalog["x"].Kind works.
	for k, m := range Catalog {
		m.Kind = k
		Catalog[k] = m
	}
}

/* ---------------- Engine ---------------- */

// Engine routes events to recipients, respects per-user preferences, dedupes
// rapid-fire events, writes the outbox, and (for immediate tier) sends mail
// via the Mailer.
type Engine struct {
	db     *pgxpool.Pool
	mailer *Mailer
	cfg    *config.Config
	log    *slog.Logger
}

func NewEngine(db *pgxpool.Pool, m *Mailer, cfg *config.Config) *Engine {
	return &Engine{db: db, mailer: m, cfg: cfg, log: slog.Default()}
}

// Recipient identifies who gets the event. Either UserID (preferred — we look
// up email + prefs) or Email (escape hatch for not-yet-registered invitees).
type Recipient struct {
	UserID *uuid.UUID
	Email  string // overrides user lookup if set
}

// Event is what call sites build and pass to Notify. Payload is templated into
// the catalog's subject + headline.
type Event struct {
	Kind       EventKind
	TenantID   uuid.UUID
	Recipients []Recipient
	Payload    map[string]any // template fields: {{.Title}} {{.Project}} etc.
	Link       string         // optional override of catalog DefaultLink
	DedupeKey  string         // optional — collapses duplicate fires within 5 min per recipient
	Severity   string         // optional override
}

// Notify is the single entry point. Errors are logged but do NOT fail the
// caller — sending email must never break a business action. Returns the
// number of recipients we successfully queued/sent for (0 on full failure).
func (e *Engine) Notify(ctx context.Context, ev Event) int {
	if e == nil || e.db == nil {
		return 0
	}
	meta, ok := Catalog[ev.Kind]
	if !ok {
		e.log.Warn("notify: unknown event kind", "kind", ev.Kind)
		return 0
	}

	subject := renderTpl(meta.SubjectTpl, ev.Payload)
	link := ev.Link
	if link == "" && meta.DefaultLink != "" {
		link = renderTpl(meta.DefaultLink, ev.Payload)
	}
	// Email clients can't resolve relative URLs — Gmail in particular renders
	// them as the literal `[/path]label` text rather than an anchor. Turn any
	// leading-slash path into an absolute URL using the app's public origin.
	link = absoluteURL(e.cfg, link)
	payloadJSON, _ := json.Marshal(ev.Payload)

	// Fan the event out to any Teams webhooks the tenant has configured. Runs
	// in parallel with the per-user dispatch loop — Teams must never block
	// the in-app + email path.
	go e.dispatchTeams(ctx, meta, ev, subject, link)

	queued := 0
	for _, r := range ev.Recipients {
		email, userID := r.Email, r.UserID
		if userID != nil && email == "" {
			_ = e.db.QueryRow(ctx, `SELECT email::text FROM users WHERE id=$1 AND deleted_at IS NULL`, *userID).Scan(&email)
		}
		if email == "" {
			continue
		}

		// Dedupe: same dedupeKey for same user within 5 min → skip.
		if ev.DedupeKey != "" && userID != nil {
			var dupID uuid.UUID
			err := e.db.QueryRow(ctx, `
				SELECT id FROM notification_outbox
				WHERE user_id=$1 AND dedupe_key=$2 AND created_at > now() - interval '5 minutes'
				LIMIT 1`, *userID, ev.DedupeKey).Scan(&dupID)
			if err == nil {
				continue // already queued
			}
		}

		tier := e.resolveTier(ctx, userID, meta.Category, meta.DefaultTier)

		// Critical-severity events bypass user "off" / digest preferences.
		// Spec rule: blockers, overdue approvals, high risk, SLA breach,
		// payment approvals always email immediately. The user can mute the
		// rest of the category but not these.
		severity := meta.Severity
		if ev.Severity != "" {
			severity = ev.Severity
		}
		if severity == "critical" {
			tier = TierImmediate
		}

		if tier == TierOff {
			continue
		}

		// Insert into outbox.
		var rowID uuid.UUID
		err := e.db.QueryRow(ctx, `
			INSERT INTO notification_outbox
			  (tenant_id, user_id, email, event_kind, category, tier, subject, payload, link, dedupe_key)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULLIF($10,''))
			RETURNING id`,
			ev.TenantID, userID, email, string(ev.Kind), string(meta.Category),
			string(tier), subject, payloadJSON, link, ev.DedupeKey).Scan(&rowID)
		if err != nil {
			e.log.Warn("notify: outbox insert failed", "err", err, "kind", ev.Kind)
			continue
		}
		queued++

		// Immediate tier → fire email now (fire-and-forget).
		if tier == TierImmediate && e.mailer != nil && e.mailer.Configured() {
			go e.send(rowID, email, subject, meta, ev.Payload, link)
		}
	}
	return queued
}

func (e *Engine) send(rowID uuid.UUID, to, subject string, meta EventMeta, payload map[string]any, link string) {
	html := renderImmediateHTML(meta, subject, payload, link, absoluteURL(e.cfg, "/my-work?tab=profile"))
	plain := renderImmediatePlain(meta, subject, payload, link)
	err := e.mailer.Send(context.Background(), Email{To: to, Subject: subject, Plain: plain, HTML: html})
	if err != nil {
		_, _ = e.db.Exec(context.Background(),
			`UPDATE notification_outbox SET error=$1, sent_at=now() WHERE id=$2`,
			err.Error(), rowID)
		e.log.Warn("notify: send failed", "to", to, "kind", meta.Kind, "err", err)
		return
	}
	_, _ = e.db.Exec(context.Background(),
		`UPDATE notification_outbox SET sent_at=now(), delivered=true WHERE id=$1`, rowID)
}

// resolveTier looks up the user's stored preference for this category, falling
// back to the catalog default.
func (e *Engine) resolveTier(ctx context.Context, userID *uuid.UUID, cat Category, def Tier) Tier {
	if userID == nil {
		return def
	}
	var t string
	err := e.db.QueryRow(ctx,
		`SELECT tier FROM notification_category_prefs WHERE user_id=$1 AND category=$2`,
		*userID, string(cat)).Scan(&t)
	if err != nil {
		return def
	}
	switch Tier(t) {
	case TierImmediate, TierDigestDaily, TierDigestWeekly, TierOff:
		return Tier(t)
	}
	return def
}

/* ---------------- Template rendering ---------------- */

// renderTpl supports {{.Field}} and {{.Field|fallback}} (no Sprig — keeping
// dependencies tiny). Missing fields render as empty.
func renderTpl(tpl string, fields map[string]any) string {
	out := tpl
	// Naïve {{.Field}} replacement; good enough for short subject lines.
	for {
		i := strings.Index(out, "{{")
		j := strings.Index(out, "}}")
		if i < 0 || j < 0 || j < i {
			break
		}
		expr := strings.TrimSpace(out[i+2 : j])
		expr = strings.TrimPrefix(expr, ".")
		val := ""
		if v, ok := fields[expr]; ok && v != nil {
			val = fmt.Sprint(v)
		}
		out = out[:i] + val + out[j+2:]
	}
	return out
}

func renderImmediatePlain(meta EventMeta, subject string, fields map[string]any, link string) string {
	var b strings.Builder
	b.WriteString(subject + "\n\n")
	b.WriteString(renderTpl(meta.HeadlineTpl, fields) + "\n\n")
	for k, v := range fields {
		if k == "Workspace" || k == "Severity" {
			continue
		}
		b.WriteString(fmt.Sprintf("%s: %v\n", k, v))
	}
	if link != "" {
		b.WriteString("\nOpen: " + link + "\n")
	}
	b.WriteString("\n— D'Accubin\n")
	return b.String()
}

func renderImmediateHTML(meta EventMeta, subject string, fields map[string]any, link, settingsURL string) string {
	headline := renderTpl(meta.HeadlineTpl, fields)
	severity := meta.Severity
	if severity == "" {
		severity = "info"
	}
	bandColor := map[string]string{
		"info":     "#0F7B97",
		"warn":     "#d97706",
		"critical": "#dc2626",
	}[severity]
	if bandColor == "" {
		bandColor = "#0F7B97"
	}
	cta := ""
	if link != "" {
		cta = fmt.Sprintf(
			`<a href="%s" style="display:inline-block;background:%s;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:700;font-size:13px">Open in D'Accubin</a>`,
			link, bandColor)
	}
	rows := ""
	for k, v := range fields {
		if k == "Workspace" || k == "Severity" {
			continue
		}
		rows += fmt.Sprintf(
			`<tr><td style="padding:4px 12px 4px 0;color:#64748b;font-size:12px">%s</td><td style="font-size:13px;color:#0f172a">%v</td></tr>`,
			k, v)
	}
	if settingsURL == "" {
		settingsURL = "https://myaccubin.com/my-work?tab=profile"
	}
	return fmt.Sprintf(`<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937;line-height:1.5;background:#faf7f1;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
    <div style="background:%s;height:4px"></div>
    <div style="padding:24px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:%s;font-weight:700">%s</div>
      <h1 style="margin:6px 0 12px;font-size:22px;color:#0f172a;line-height:1.25">%s</h1>
      <p style="margin:0 0 18px;font-size:14px;color:#475569">%s</p>
      <table style="margin-bottom:18px">%s</table>
      %s
    </div>
    <div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e5e7eb;font-size:11px;color:#64748b">
      You're getting this because your <strong>%s</strong> notifications are set to immediate.
      Manage what you receive in your <a href="%s" style="color:#0F7B97">workspace settings</a>.
    </div>
  </div>
</body></html>`,
		bandColor, bandColor, strings.ToUpper(severity), headline, subject, rows, cta, meta.Category, settingsURL)
}

// absoluteURL turns a "/some/path" into "https://app-host.com/some/path" so
// email clients can render it as a real anchor. Absolute URLs pass through.
// Empty strings stay empty. Used by both immediate and digest renderers.
func absoluteURL(cfg *config.Config, link string) string {
	link = strings.TrimSpace(link)
	if link == "" {
		return ""
	}
	if strings.HasPrefix(link, "http://") || strings.HasPrefix(link, "https://") {
		return link
	}
	base := ""
	if cfg != nil && len(cfg.AllowedOrigins) > 0 {
		first := strings.TrimSpace(cfg.AllowedOrigins[0])
		first = strings.TrimSuffix(first, "/")
		if first != "" && first != "*" {
			base = first
		}
	}
	if base == "" {
		base = "https://myaccubin.com"
	}
	if !strings.HasPrefix(link, "/") {
		link = "/" + link
	}
	return base + link
}

/* ---------------- Outbox / preferences read APIs ---------------- */

// PreferenceRow is what the preferences API returns to the frontend.
type PreferenceRow struct {
	Category    Category `json:"category"`
	Tier        Tier     `json:"tier"`
	IsDefault   bool     `json:"is_default"`
	Description string   `json:"description"` // human description for the UI
}

// PrefsForUser returns one row per category, falling back to the catalog
// default when the user hasn't explicitly chosen.
func (e *Engine) PrefsForUser(ctx context.Context, userID uuid.UUID) ([]PreferenceRow, error) {
	overrides := map[Category]Tier{}
	rows, err := e.db.Query(ctx,
		`SELECT category, tier FROM notification_category_prefs WHERE user_id=$1`, userID)
	if err == nil {
		for rows.Next() {
			var c, t string
			if err := rows.Scan(&c, &t); err == nil {
				overrides[Category(c)] = Tier(t)
			}
		}
		rows.Close()
	}

	// Default tier per category = the most lenient default among events in that category.
	categoryDefault := map[Category]Tier{}
	categoryDesc := map[Category]string{
		CatAccount:    "Account & access — invites, password resets, MFA changes",
		CatPipeline:   "Pipeline — opportunities, approvals, contracting",
		CatDelivery:   "Delivery — projects, milestones, status changes",
		CatTasks:      "Tasks — assignments, mentions, due dates",
		CatGovernance: "Governance & compliance — approvals, missing docs",
		CatRisk:       "Risk & escalation — blockers, SLA, critical issues",
		CatFinance:    "Finance — invoices, payments, budget alerts",
		CatVendor:     "Vendor delivery — onboarding, deliverables, vendor invoices",
		CatRelations:  "Relationships — agent engagements, intros, fees",
		CatExecDigest: "Executive digests — weekly portfolio / finance / governance reports",
	}
	for _, m := range Catalog {
		if categoryDefault[m.Category] == "" || tierWeight(m.DefaultTier) > tierWeight(categoryDefault[m.Category]) {
			categoryDefault[m.Category] = m.DefaultTier
		}
	}

	out := []PreferenceRow{}
	for cat, def := range categoryDefault {
		tier := def
		isDefault := true
		if v, ok := overrides[cat]; ok {
			tier = v
			isDefault = false
		}
		out = append(out, PreferenceRow{
			Category: cat, Tier: tier, IsDefault: isDefault,
			Description: categoryDesc[cat],
		})
	}
	return out, nil
}

func tierWeight(t Tier) int {
	switch t {
	case TierImmediate:
		return 4
	case TierDigestDaily:
		return 3
	case TierDigestWeekly:
		return 2
	case TierOff:
		return 1
	}
	return 0
}

// SetPref upserts a user's preference for one category.
func (e *Engine) SetPref(ctx context.Context, userID uuid.UUID, cat Category, tier Tier) error {
	switch tier {
	case TierImmediate, TierDigestDaily, TierDigestWeekly, TierOff:
		// ok
	default:
		return fmt.Errorf("invalid tier %q", tier)
	}
	_, err := e.db.Exec(ctx, `
		INSERT INTO notification_category_prefs (user_id, category, tier)
		VALUES ($1,$2,$3)
		ON CONFLICT (user_id, category) DO UPDATE SET tier = EXCLUDED.tier, updated_at = now()`,
		userID, string(cat), string(tier))
	return err
}

/* ---------------- Digest stubs (worker hooks) ---------------- */

// DrainDigest collects pending outbox rows for a given tier, groups them by
// recipient, renders one digest email per person, and stamps every row sent
// in a single transaction. Designed for the cron worker (08:00 daily, Monday
// weekly).
//
// Window: daily drains the last 24h, weekly the last 7d. Idempotent — already
// sent rows (sent_at IS NOT NULL) are skipped.
type DigestSummary struct {
	Recipients int
	Rows       int
}

func (e *Engine) DrainDigest(ctx context.Context, tier Tier) (DigestSummary, error) {
	if tier != TierDigestDaily && tier != TierDigestWeekly {
		return DigestSummary{}, fmt.Errorf("not a digest tier: %s", tier)
	}
	window := "24 hours"
	if tier == TierDigestWeekly {
		window = "7 days"
	}

	// 1. Pull all pending rows for the tier within the window, grouped by user.
	rows, err := e.db.Query(ctx, `
		SELECT id, user_id, email, event_kind, category, subject, payload, link, created_at
		FROM notification_outbox
		WHERE tier = $1 AND sent_at IS NULL
		  AND created_at > now() - interval `+`'`+window+`'`+`
		ORDER BY user_id, created_at DESC`,
		string(tier))
	if err != nil {
		return DigestSummary{}, err
	}
	defer rows.Close()

	byUser := map[uuid.UUID]struct {
		Email string
		Items []digestItem
	}{}
	for rows.Next() {
		var (
			id        uuid.UUID
			userID    *uuid.UUID
			email     string
			kind, cat string
			subject   string
			payload   []byte
			link      string
			createdAt time.Time
		)
		if err := rows.Scan(&id, &userID, &email, &kind, &cat, &subject, &payload, &link, &createdAt); err != nil {
			continue
		}
		if userID == nil {
			continue // can't digest to a userless recipient
		}
		var p map[string]any
		_ = json.Unmarshal(payload, &p)
		entry := byUser[*userID]
		entry.Email = email
		entry.Items = append(entry.Items, digestItem{
			ID: id, Kind: kind, Category: cat, Subject: subject,
			Payload: p, Link: link, CreatedAt: createdAt,
		})
		byUser[*userID] = entry
	}

	// 2. For each recipient, render + send one digest, then stamp rows.
	digestID := uuid.New()
	totalRows := 0
	for _, bundle := range byUser {
		if len(bundle.Items) == 0 {
			continue
		}
		subject, plain, html := renderDigest(tier, bundle.Items)
		ids := make([]uuid.UUID, 0, len(bundle.Items))
		for _, it := range bundle.Items {
			ids = append(ids, it.ID)
		}

		var sendErr error
		if e.mailer != nil && e.mailer.Configured() {
			sendErr = e.mailer.Send(ctx, Email{
				To: bundle.Email, Subject: subject, Plain: plain, HTML: html,
			})
		}
		if sendErr != nil {
			e.log.Warn("digest send failed", "to", bundle.Email, "err", sendErr)
			_, _ = e.db.Exec(ctx, `
				UPDATE notification_outbox
				SET digest_id=$1, sent_at=now(), delivered=false, error=$2
				WHERE id = ANY($3)`, digestID, sendErr.Error(), ids)
			continue
		}
		_, _ = e.db.Exec(ctx, `
			UPDATE notification_outbox
			SET digest_id=$1, sent_at=now(), delivered=true
			WHERE id = ANY($2)`, digestID, ids)
		totalRows += len(ids)
	}
	return DigestSummary{Recipients: len(byUser), Rows: totalRows}, nil
}

type digestItem struct {
	ID        uuid.UUID
	Kind      string
	Category  string
	Subject   string
	Payload   map[string]any
	Link      string
	CreatedAt time.Time
}

func renderDigest(tier Tier, items []digestItem) (subject, plain, html string) {
	period := "today"
	if tier == TierDigestWeekly {
		period = "this week"
	}
	subject = fmt.Sprintf("D'Accubin · %d update%s %s",
		len(items), pluralS(len(items)), period)

	// Group by category for clean sectioning.
	byCat := map[string][]struct {
		Headline string
		Link     string
	}{}
	for _, it := range items {
		meta, ok := Catalog[EventKind(it.Kind)]
		headline := it.Subject
		if ok {
			headline = renderTpl(meta.HeadlineTpl, it.Payload)
		}
		byCat[it.Category] = append(byCat[it.Category], struct {
			Headline string
			Link     string
		}{Headline: headline, Link: it.Link})
	}

	// Plain text
	var p strings.Builder
	p.WriteString(subject + "\n\n")
	for cat, list := range byCat {
		p.WriteString(strings.ToUpper(cat) + " (" + fmt.Sprint(len(list)) + ")\n")
		for _, h := range list {
			p.WriteString("  • " + h.Headline)
			if h.Link != "" {
				p.WriteString("  " + h.Link)
			}
			p.WriteString("\n")
		}
		p.WriteString("\n")
	}
	p.WriteString("— D'Accubin\n")
	plain = p.String()

	// HTML — single column, sectioned per category, accent header strip
	var b strings.Builder
	b.WriteString(`<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#faf7f1;color:#1f2937;line-height:1.5;padding:24px"><div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden"><div style="background:#0F7B97;height:4px"></div><div style="padding:24px">`)
	b.WriteString(fmt.Sprintf(`<div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#0F7B97;font-weight:700">%s digest</div>`, period))
	b.WriteString(fmt.Sprintf(`<h1 style="margin:6px 0 18px;font-size:22px;color:#0f172a">%s</h1>`, subject))

	for cat, list := range byCat {
		b.WriteString(fmt.Sprintf(`<div style="margin-bottom:18px"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#64748b;font-weight:700;margin-bottom:8px">%s · %d</div><ul style="list-style:none;padding:0;margin:0">`,
			strings.ReplaceAll(cat, "_", " "), len(list)))
		for _, h := range list {
			if h.Link != "" {
				b.WriteString(fmt.Sprintf(`<li style="padding:6px 0;border-bottom:1px solid #f1f5f9"><a href="%s" style="color:#0f172a;text-decoration:none;font-size:13.5px">› %s</a></li>`, h.Link, h.Headline))
			} else {
				b.WriteString(fmt.Sprintf(`<li style="padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:13.5px;color:#0f172a">› %s</li>`, h.Headline))
			}
		}
		b.WriteString(`</ul></div>`)
	}
	b.WriteString(`</div><div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e5e7eb;font-size:11px;color:#64748b">You're getting this because some of your notification preferences are set to digest. Adjust the cadence in your workspace settings.</div></div></body></html>`)
	html = b.String()
	return
}

func pluralS(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

/* ---------------- Helper: resolve recipients by role ---------------- */

// RecipientsByRole returns the set of users in the tenant who have any of the
// given role names. Useful for "all reviewers" / "all finance" notifications.
func (e *Engine) RecipientsByRole(ctx context.Context, tenantID uuid.UUID, roles ...string) []Recipient {
	if len(roles) == 0 {
		return nil
	}
	out := []Recipient{}
	rows, err := e.db.Query(ctx, `
		SELECT DISTINCT u.id
		FROM users u
		JOIN user_roles ur ON ur.user_id = u.id
		JOIN roles r ON r.id = ur.role_id
		WHERE u.tenant_id=$1 AND u.deleted_at IS NULL AND r.name = ANY($2)`,
		tenantID, roles)
	if err != nil {
		return nil
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			out = append(out, Recipient{UserID: &id})
		}
	}
	return out
}

/* ---------------- Time helpers ---------------- */

// nextDigestSendAt returns the next 08:00 (local-ish UTC) for the daily digest.
// Hook for the worker; unused right now.
func nextDigestSendAt(now time.Time) time.Time {
	t := time.Date(now.Year(), now.Month(), now.Day(), 8, 0, 0, 0, now.Location())
	if !t.After(now) {
		t = t.Add(24 * time.Hour)
	}
	return t
}
var _ = nextDigestSendAt // keep referenced
