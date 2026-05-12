package router

import (
	"log/slog"
	"net/http"

	"github.com/decapods/pgdp/backend/internal/http/handlers"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/notifications"
	"github.com/decapods/pgdp/backend/internal/platform/config"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type Deps struct {
	Cfg   *config.Config
	Log   *slog.Logger
	DB    *pgxpool.Pool
	Redis *redis.Client
}

func New(d Deps) http.Handler {
	if d.Cfg.Env == "production" {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.Use(gin.Recovery(), mw.RequestID(), mw.AccessLog())
	r.Use(cors.New(cors.Config{
		AllowOrigins:     d.Cfg.AllowedOrigins,
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Authorization", "Content-Type", "X-Request-ID", "Idempotency-Key"},
		ExposeHeaders:    []string{"X-Request-ID"},
		AllowCredentials: true,
	}))

	r.GET("/healthz", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	r.GET("/readyz", func(c *gin.Context) {
		if err := d.DB.Ping(c.Request.Context()); err != nil {
			c.JSON(503, gin.H{"ok": false, "err": err.Error()})
			return
		}
		c.JSON(200, gin.H{"ok": true})
	})

	api := r.Group("/api/v1")

	auth := handlers.NewAuth(d.DB, d.Cfg)
	api.POST("/auth/login", auth.Login)
	api.POST("/auth/refresh", auth.Refresh)
	api.POST("/auth/mfa/verify", auth.VerifyMFA)

	// Build the notification engine early so handlers can attach it.
	earlyMailer := notifications.NewMailer(d.Cfg)

	// Password reset — public, no auth required.
	pwReset := handlers.NewPasswordReset(d.DB, earlyMailer, d.Cfg)
	api.POST("/auth/forgot-password",        pwReset.Request)
	api.POST("/auth/reset-password",         pwReset.Reset)
	api.GET("/auth/reset-password/:token",   pwReset.Verify)

	authed := api.Group("")
	authed.Use(mw.RequireAuth([]byte(d.Cfg.JWTAccessSecret)))

	authed.GET("/me", auth.Me)

	// Self-service MFA enrollment + admin enforcement toggle.
	authed.POST("/me/mfa/begin",    auth.BeginMFAEnrollment)
	authed.POST("/me/mfa/confirm",  auth.ConfirmMFAEnrollment)
	authed.POST("/me/mfa/disable",  auth.DisableMFA)
	authed.PATCH("/members/:id/mfa-required", mw.RequirePermission("governance:write"), auth.AdminSetMFARequired)

	earlyEngine := notifications.NewEngine(d.DB, earlyMailer, d.Cfg)

	opp := handlers.NewOpportunities(d.DB).WithEngine(earlyEngine)
	authed.GET("/opportunities", mw.RequirePermission("opportunity:read"), opp.List)
	authed.POST("/opportunities", mw.RequirePermission("opportunity:write"), opp.Create)
	authed.GET("/opportunities/:id", mw.RequirePermission("opportunity:read"), opp.Get)
	authed.PATCH("/opportunities/:id", mw.RequirePermission("opportunity:write"), opp.Update)
	authed.DELETE("/opportunities/:id", mw.RequirePermission("opportunity:write"), opp.Delete)
	authed.POST("/opportunities/:id/submit", mw.RequirePermission("opportunity:write"), opp.Submit)
	authed.POST("/opportunities/:id/transition", mw.RequirePermission("opportunity:write"), opp.Transition)
	authed.POST("/opportunities/:id/documents", mw.RequirePermission("document:write"), opp.AttachDocument)

	workflows := handlers.NewWorkflows(d.DB)
	authed.GET("/settings/opportunity-workflow", mw.RequirePermission("opportunity:read"), workflows.GetOpportunityWorkflow)
	authed.PUT("/settings/opportunity-workflow", mw.RequirePermission("governance:write"), workflows.PutOpportunityWorkflow)

	general := handlers.NewGeneralSettings(d.DB)
	authed.GET("/settings/general", general.Get)
	authed.PUT("/settings/general", mw.RequirePermission("governance:write"), general.Put)

	workPolicy := handlers.NewWorkPolicy(d.DB)
	authed.GET("/settings/work-policy", workPolicy.Get)
	authed.PUT("/settings/work-policy", mw.RequirePermission("governance:write"), workPolicy.Put)

	teamsIntegration := handlers.NewTeamsIntegration(d.DB)
	authed.GET("/settings/teams",            mw.RequirePermission("governance:write"), teamsIntegration.Get)
	authed.PUT("/settings/teams",            mw.RequirePermission("governance:write"), teamsIntegration.Put)
	authed.POST("/settings/teams/test/:id",  mw.RequirePermission("governance:write"), teamsIntegration.Test)

	// Microsoft / Entra ID integration.
	//   • /settings/microsoft — admin-only credentials.
	//   • /me/microsoft/*    — per-user connect / disconnect / status.
	//   • /me/meetings       — calendar feed pulled via Graph.
	//   • /auth/microsoft/callback — public; verified via HMAC-signed state.
	msAdmin := handlers.NewMicrosoftAdmin(d.DB, d.Cfg)
	authed.GET("/settings/microsoft", mw.RequirePermission("governance:write"), msAdmin.Get)
	authed.PUT("/settings/microsoft", mw.RequirePermission("governance:write"), msAdmin.Put)

	msOAuth := handlers.NewMicrosoftOAuth(d.DB, d.Cfg)
	authed.GET("/me/microsoft/start",       msOAuth.Start)
	authed.POST("/me/microsoft/disconnect", msOAuth.Disconnect)
	authed.GET("/me/microsoft/status",      msOAuth.Status)
	authed.GET("/me/meetings",              msOAuth.Meetings)
	authed.GET("/me/mail",                  msOAuth.Mail)
	authed.GET("/me/mail/:id",              msOAuth.Message)
	api.GET("/auth/microsoft/callback",     msOAuth.Callback)

	rv := handlers.NewRoleVisibility(d.DB)
	authed.GET("/settings/role-visibility", rv.Get)
	authed.PUT("/settings/role-visibility", mw.RequirePermission("governance:write"), rv.Put)
	authed.GET("/me/visibility",            rv.MeVisibility)

	teamRates := handlers.NewTeamRates(d.DB)
	authed.GET("/settings/team-rates", mw.RequirePermission("opportunity:read"), teamRates.List)
	authed.PUT("/settings/team-rates", mw.RequirePermission("governance:write"), teamRates.Upsert)
	authed.DELETE("/settings/team-rates/:id", mw.RequirePermission("governance:write"), teamRates.Delete)

	notif := handlers.NewNotifications(d.DB)
	authed.GET("/notifications", notif.List)
	authed.POST("/notifications/:id/read", notif.MarkRead)
	authed.POST("/notifications/read-all", notif.MarkAllRead)
	authed.POST("/notifications/:id/dismiss", notif.Dismiss)
	authed.POST("/notifications/dismiss-all", notif.DismissAll)

	sysAudit := handlers.NewSystemAudit(d.DB)
	authed.GET("/admin/audit", sysAudit.List)

	huddle := handlers.NewHuddle(d.DB)
	authed.GET("/me/huddle",  huddle.Get)
	authed.POST("/me/huddle", huddle.Save)

	// Personal portal — every endpoint here is scoped to the logged-in user.
	me := handlers.NewMe(d.DB).WithEngine(earlyEngine)
	authed.GET("/me/work",        me.Work)
	authed.GET("/me/tasks",       me.Tasks)
	authed.POST("/me/tasks/:id/status",   me.UpdateTaskStatus)
	authed.GET("/me/tasks/:id/comments",  me.TaskComments)
	authed.POST("/me/tasks/:id/comments", me.AddTaskComment)
	authed.GET("/me/updates",     me.Updates)
	authed.POST("/me/updates",    me.AddUpdate)
	authed.GET("/me/timesheet",   me.Timesheet)
	authed.GET("/me/files",       me.Files)
	authed.GET("/me/profile",     me.Profile)
	authed.PUT("/me/profile",     me.PutProfile)
	authed.POST("/me/heartbeat",  me.Heartbeat)
	authed.GET("/me/status",      me.MyStatus)
	authed.PUT("/me/status",      me.SetMyStatus)
	authed.GET("/presence",       me.Presence)

	vendors := handlers.NewVendors(d.DB)
	authed.GET("/vendors",                          mw.RequirePermission("opportunity:read"),  vendors.List)
	authed.POST("/vendors",                         mw.RequirePermission("opportunity:write"), vendors.Create)
	authed.GET("/vendors/:id",                      mw.RequirePermission("opportunity:read"),  vendors.Get)
	authed.PATCH("/vendors/:id",                    mw.RequirePermission("opportunity:write"), vendors.Update)
	authed.DELETE("/vendors/:id",                   mw.RequirePermission("opportunity:write"), vendors.Delete)
	authed.POST("/vendors/:id/sla/sign",            mw.RequirePermission("opportunity:write"), vendors.SignSLA)
	authed.POST("/vendors/:id/documents",           mw.RequirePermission("opportunity:write"), vendors.AddDocument)
	authed.DELETE("/vendors/:id/documents/:docId", mw.RequirePermission("opportunity:write"), vendors.DeleteDocument)
	authed.POST("/vendors/:id/invite",              mw.RequirePermission("opportunity:write"), vendors.CreateInvite)
	authed.GET("/vendors/:id/invites",              mw.RequirePermission("opportunity:read"),  vendors.ListInvites)
	authed.DELETE("/vendor-invitations/:inviteId", mw.RequirePermission("opportunity:write"), vendors.RevokeInvite)
	api.GET("/vendor-invite/:token",  vendors.PublicGetInvite)
	api.POST("/vendor-invite/:token", vendors.PublicAcceptInvite)

	agents := handlers.NewAgents(d.DB)
	authed.GET("/agents",                          mw.RequirePermission("opportunity:read"),  agents.List)
	authed.POST("/agents",                         mw.RequirePermission("opportunity:write"), agents.Create)
	authed.GET("/agents/:id",                      mw.RequirePermission("opportunity:read"),  agents.Get)
	authed.PATCH("/agents/:id",                    mw.RequirePermission("opportunity:write"), agents.Update)
	authed.DELETE("/agents/:id",                   mw.RequirePermission("opportunity:write"), agents.Delete)
	authed.POST("/agents/:id/documents",           mw.RequirePermission("opportunity:write"), agents.AddDocument)
	authed.DELETE("/agents/:id/documents/:docId", mw.RequirePermission("opportunity:write"), agents.DeleteDocument)
	authed.POST("/agents/:id/invite",              mw.RequirePermission("opportunity:write"), agents.CreateInvite)
	authed.GET("/agents/:id/invites",              mw.RequirePermission("opportunity:read"),  agents.ListInvites)
	authed.DELETE("/agent-invitations/:inviteId", mw.RequirePermission("opportunity:write"), agents.RevokeInvite)
	api.GET("/agent-invite/:token",  agents.PublicGetInvite)
	api.POST("/agent-invite/:token", agents.PublicAcceptInvite)

	prefs := handlers.NewNotificationPrefs(earlyEngine)
	authed.GET("/me/notification-preferences",  prefs.List)
	authed.PUT("/me/notification-preferences",  prefs.Set)
	authed.POST("/admin/digests/run",           mw.RequirePermission("governance:write"), prefs.RunDigest)

	members := handlers.NewMembers(d.DB).WithMailer(earlyMailer, d.Cfg)
	authed.GET("/members",                   members.List)
	authed.GET("/members/roles",             members.ListRoles)
	authed.GET("/members/:id/profile",       members.Profile)
	authed.POST("/members",                  mw.RequirePermission("governance:write"), members.Create)
	authed.PATCH("/members/:id",             mw.RequirePermission("governance:write"), members.Update)
	authed.POST("/members/:id/reset-password", mw.RequirePermission("governance:write"), members.ResetPassword)
	authed.DELETE("/members/:id",            mw.RequirePermission("governance:write"), members.Delete)
	authed.POST("/members/invite",           mw.RequirePermission("governance:write"), members.CreateInvite)
	authed.GET("/members/invitations",       mw.RequirePermission("governance:write"), members.ListInvites)
	authed.DELETE("/member-invitations/:inviteId", mw.RequirePermission("governance:write"), members.RevokeInvite)
	authed.POST("/member-invitations/:inviteId/resend", mw.RequirePermission("governance:write"), members.ResendInvite)
	authed.DELETE("/member-invitations/:inviteId/hard", mw.RequirePermission("governance:write"), members.DeleteInvite)
	api.GET("/member-invite/:token",  members.PublicGetInvite)
	api.POST("/member-invite/:token", members.PublicAcceptInvite)

	stakeholders := handlers.NewStakeholders(d.DB)
	authed.GET("/stakeholders",       mw.RequirePermission("opportunity:read"),  stakeholders.ListAll)
	authed.PATCH("/stakeholders/:id", mw.RequirePermission("opportunity:write"), stakeholders.Update)
	authed.GET("/opportunities/:id/stakeholders", mw.RequirePermission("opportunity:read"), stakeholders.ListOpportunity)
	authed.POST("/opportunities/:id/stakeholders", mw.RequirePermission("opportunity:write"), stakeholders.AddOpportunity)
	authed.GET("/projects/:id/stakeholders", mw.RequirePermission("project:read"), stakeholders.ListProject)
	authed.POST("/projects/:id/stakeholders", mw.RequirePermission("project:write"), stakeholders.AddProject)
	authed.DELETE("/stakeholders/:id", mw.RequirePermission("opportunity:write"), stakeholders.Delete)

	proj := handlers.NewProjects(d.DB).WithEngine(earlyEngine)
	authed.GET("/projects", mw.RequirePermission("project:read"), proj.List)
	authed.POST("/projects", mw.RequirePermission("project:write"), proj.Create)
	authed.GET("/projects/:id", mw.RequirePermission("project:read"), proj.Get)
	authed.GET("/projects/:id/board", mw.RequirePermission("project:read"), proj.Board)
	authed.GET("/projects/:id/automation", mw.RequirePermission("project:read"),  proj.GetAutomation)
	authed.PUT("/projects/:id/automation", mw.RequirePermission("project:write"), proj.PutAutomation)
	authed.POST("/projects/:id/milestones", mw.RequirePermission("milestone:write"), proj.AddMilestone)
	authed.POST("/projects/:id/tasks", mw.RequirePermission("task:write"), proj.AddTask)
	authed.PATCH("/projects/:id/tasks/:taskId", mw.RequirePermission("task:write"), proj.PatchTask)
	authed.GET("/projects/:id/tasks/:taskId/comments",  mw.RequirePermission("project:read"), proj.ListTaskComments)
	authed.POST("/projects/:id/tasks/:taskId/comments", mw.RequirePermission("task:write"), proj.AddTaskComment)
	authed.POST("/projects/:id/risk/recalculate", mw.RequirePermission("risk:write"), proj.RecalculateRisk)
	authed.PUT("/projects/:id/links", mw.RequirePermission("project:write"), proj.UpdateLinks)
	authed.POST("/projects/:id/log/:kind", mw.RequirePermission("project:write"), proj.AppendLog)
	authed.PATCH("/projects/:id/log/:kind/:itemId", mw.RequirePermission("project:write"), proj.PatchLog)
	authed.PUT("/projects/:id/checkpoints", mw.RequirePermission("project:write"), proj.SetCheckpoints)
	authed.POST("/projects/:id/archive", mw.RequirePermission("project:write"), proj.Archive)
	authed.GET("/settings/archived-projects", proj.ListArchived)
	authed.POST("/projects/:id/restore", proj.Restore)

	leave := handlers.NewLeave(d.DB).WithEngine(earlyEngine)
	authed.GET("/leave/types",                leave.ListTypes)
	authed.GET("/leave/balances",             leave.Balances)
	authed.GET("/leave/requests",             leave.ListRequests)
	authed.GET("/leave/my-pending",           leave.MyPending)
	authed.POST("/leave/requests",            leave.CreateRequest)
	authed.POST("/leave/requests/:id/decision", leave.Decide)
	authed.GET("/leave/decision-authority",   leave.DecisionAuthority)
	authed.POST("/leave/requests/:id/cancel", leave.Cancel)
	authed.DELETE("/leave/requests/:id",      leave.Delete)
	authed.GET("/leave/dashboard",            leave.Dashboard)
	authed.GET("/leave/calendar",             leave.Calendar)
	authed.GET("/leave/public-holidays",      leave.PublicHolidays)
	authed.POST("/leave/public-holidays",     mw.RequirePermission("governance:write"), leave.AddPublicHoliday)

	exp := handlers.NewExpenses(d.DB)
	authed.GET("/expense-categories",                   exp.Categories)
	authed.GET("/projects/:id/expenses",                mw.RequirePermission("project:read"),  exp.List)
	authed.POST("/projects/:id/expenses",               mw.RequirePermission("project:write"), exp.Add)
	authed.DELETE("/projects/:id/expenses/:expenseId", mw.RequirePermission("project:write"), exp.Delete)

	pmembers := handlers.NewProjectMembers(d.DB)
	authed.GET("/projects/:id/members",                 mw.RequirePermission("project:read"),  pmembers.List)
	authed.GET("/projects/:id/members/assignable",      mw.RequirePermission("project:read"),  pmembers.Assignable)
	authed.POST("/projects/:id/members",                mw.RequirePermission("project:write"), pmembers.Add)
	authed.DELETE("/projects/:id/members/:memberId",   mw.RequirePermission("project:write"), pmembers.Remove)

	// Project files — first-class working artefacts (change requests,
	// architecture, scope notes, etc.). Visibility is enforced inside the
	// handler so we keep a single read permission.
	pfiles := handlers.NewProjectFiles(d.DB)
	authed.GET("/projects/:id/files",                       mw.RequirePermission("project:read"),  pfiles.List)
	authed.POST("/projects/:id/files",                      mw.RequirePermission("project:write"), pfiles.Upload)
	authed.GET("/projects/:id/files/:fileId/download",      mw.RequirePermission("project:read"),  pfiles.Download)
	authed.PATCH("/projects/:id/files/:fileId",             mw.RequirePermission("project:write"), pfiles.Update)
	authed.DELETE("/projects/:id/files/:fileId",            mw.RequirePermission("project:write"), pfiles.Delete)

	wf := handlers.NewWorkforce(d.DB)
	authed.GET("/workforce/load", mw.RequirePermission("workforce:read"), wf.Load)
	authed.GET("/workforce/burnout", mw.RequirePermission("workforce:read"), wf.Burnout)
	authed.POST("/workforce/time-entries", mw.RequirePermission("time_entry:write"), wf.LogTime)

	fin := handlers.NewFinance(d.DB).WithEngine(earlyEngine)
	authed.GET("/finance/invoices", mw.RequirePermission("invoice:read"), fin.ListInvoices)
	authed.POST("/finance/invoices", mw.RequirePermission("invoice:write"), fin.CreateInvoice)
	authed.POST("/finance/payments", mw.RequirePermission("payment:write"), fin.RecordPayment)
	authed.GET("/finance/receivables", mw.RequirePermission("invoice:read"), fin.Receivables)
	authed.GET("/finance/summary",     mw.RequirePermission("invoice:read"), fin.Summary)
	authed.GET("/finance/billable",    mw.RequirePermission("invoice:read"), fin.Billable)
	authed.PATCH("/finance/invoices/:id/status", mw.RequirePermission("invoice:write"), fin.UpdateInvoiceStatus)
	authed.POST("/finance/invoices/lookup-irn",  mw.RequirePermission("invoice:read"),  fin.LookupIRN)
	authed.GET("/finance/invoices/:id/payments", mw.RequirePermission("invoice:read"),  fin.ListInvoicePayments)

	gov := handlers.NewGovernance(d.DB)
	authed.GET("/governance/policies", mw.RequirePermission("policy:read"), gov.ListPolicies)
	authed.POST("/governance/policies", mw.RequirePermission("policy:write"), gov.UpsertPolicy)
	authed.DELETE("/governance/policies/:id", mw.RequirePermission("policy:write"), gov.DeletePolicy)
	authed.GET("/audit", mw.RequirePermission("audit:read"), gov.Audit)

	an := handlers.NewAnalytics(d.DB)
	authed.GET("/analytics/executive", mw.RequirePermission("analytics:read"), an.Executive)
	authed.GET("/analytics/portfolio-health", mw.RequirePermission("analytics:read"), an.PortfolioHealth)

	gh := handlers.NewGitHub(d.DB, d.Cfg)
	authed.GET("/integrations/github/status",      gh.Status)
	authed.GET("/integrations/github/repos",       gh.ListRepos)
	authed.POST("/integrations/github/link",       mw.RequirePermission("project:write"), gh.LinkRepo)
	authed.DELETE("/integrations/github/repos/:id", mw.RequirePermission("project:write"), gh.UnlinkRepo)
	api.POST("/integrations/github/webhook",       gh.Webhook)

	ws := handlers.NewWS(d.Redis)
	authed.GET("/ws", ws.Handle)

	// Campfire — workspace social layer. All endpoints are gated by auth only;
	// reads are open to all members, writes too (anyone can post, kudo, ask
	// for help). Admin-only routes (insights, pin, delete-any, room create)
	// require governance:write.
	cf := handlers.NewCampfire(d.DB).WithEngine(earlyEngine)
	authed.GET("/campfire/presence", cf.Presence)
	authed.GET("/campfire/spotlight", cf.Spotlight)
	authed.GET("/campfire/link-preview", cf.LinkPreview)

	authed.GET("/campfire/posts",         cf.ListPosts)
	authed.POST("/campfire/posts",        cf.CreatePost)
	authed.DELETE("/campfire/posts/:id",  cf.DeletePost)
	authed.POST("/campfire/posts/:id/pin", mw.RequirePermission("governance:write"), cf.PinPost)
	authed.GET("/campfire/posts/:id/comments",  cf.ListComments)
	authed.POST("/campfire/posts/:id/comments", cf.AddComment)

	authed.POST("/campfire/react/:kind/:id", cf.ToggleReaction)

	authed.GET("/campfire/kudos",  cf.ListKudos)
	authed.POST("/campfire/kudos", cf.GiveKudo)

	authed.GET("/campfire/mood/today", cf.MyMoodToday)
	authed.PUT("/campfire/mood/today", cf.SetMyMood)
	authed.GET("/campfire/mood/trend", mw.RequirePermission("governance:write"), cf.MoodTrend)

	authed.GET("/campfire/help",            cf.ListHelp)
	authed.POST("/campfire/help",           cf.CreateHelp)
	authed.PATCH("/campfire/help/:id/status", cf.UpdateHelpStatus)

	authed.GET("/campfire/rooms",            cf.ListRooms)
	authed.POST("/campfire/rooms",           mw.RequirePermission("governance:write"), cf.CreateRoom)
	authed.GET("/campfire/rooms/:id/messages",  cf.ListMessages)
	authed.POST("/campfire/rooms/:id/messages", cf.SendMessage)

	authed.GET("/campfire/insights", mw.RequirePermission("governance:write"), cf.Insights)
	authed.GET("/campfire/unread",     cf.Unread)
	authed.POST("/campfire/mark-seen", cf.MarkSeen)

	// Attendance — HR / leadership only. The data is collected automatically
	// from heartbeats, tasks, mood etc.; staff don't punch a clock.
	att := handlers.NewAttendance(d.DB)
	authed.GET("/attendance/today",        mw.RequirePermission("governance:write"), att.Today)
	authed.GET("/attendance/trend",        mw.RequirePermission("governance:write"), att.Trend)
	authed.GET("/attendance/insights",     mw.RequirePermission("governance:write"), att.Insights)
	authed.GET("/attendance/appraisal",    mw.RequirePermission("governance:write"), att.Appraisal)
	authed.GET("/attendance/member/:id",   mw.RequirePermission("governance:write"), att.Member)
	authed.GET("/attendance/warnings",         mw.RequirePermission("governance:write"), att.Warnings)
	authed.POST("/attendance/warnings/:id/ack", mw.RequirePermission("governance:write"), att.AcknowledgeWarning)

	return r
}
