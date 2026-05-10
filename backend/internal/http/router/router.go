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

	authed := api.Group("")
	authed.Use(mw.RequireAuth([]byte(d.Cfg.JWTAccessSecret)))

	authed.GET("/me", auth.Me)

	opp := handlers.NewOpportunities(d.DB)
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

	teamRates := handlers.NewTeamRates(d.DB)
	authed.GET("/settings/team-rates", mw.RequirePermission("opportunity:read"), teamRates.List)
	authed.PUT("/settings/team-rates", mw.RequirePermission("governance:write"), teamRates.Upsert)
	authed.DELETE("/settings/team-rates/:id", mw.RequirePermission("governance:write"), teamRates.Delete)

	notif := handlers.NewNotifications(d.DB)
	authed.GET("/notifications", notif.List)
	authed.POST("/notifications/:id/read", notif.MarkRead)
	authed.POST("/notifications/read-all", notif.MarkAllRead)

	// Personal portal — every endpoint here is scoped to the logged-in user.
	me := handlers.NewMe(d.DB)
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

	mailer := notifications.NewMailer(d.Cfg)
	members := handlers.NewMembers(d.DB).WithMailer(mailer, d.Cfg)
	authed.GET("/members",                   members.List)
	authed.GET("/members/roles",             members.ListRoles)
	authed.POST("/members",                  mw.RequirePermission("governance:write"), members.Create)
	authed.PATCH("/members/:id",             mw.RequirePermission("governance:write"), members.Update)
	authed.POST("/members/:id/reset-password", mw.RequirePermission("governance:write"), members.ResetPassword)
	authed.DELETE("/members/:id",            mw.RequirePermission("governance:write"), members.Delete)
	authed.POST("/members/invite",           mw.RequirePermission("governance:write"), members.CreateInvite)
	authed.GET("/members/invitations",       mw.RequirePermission("governance:write"), members.ListInvites)
	authed.DELETE("/member-invitations/:inviteId", mw.RequirePermission("governance:write"), members.RevokeInvite)
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

	proj := handlers.NewProjects(d.DB)
	authed.GET("/projects", mw.RequirePermission("project:read"), proj.List)
	authed.POST("/projects", mw.RequirePermission("project:write"), proj.Create)
	authed.GET("/projects/:id", mw.RequirePermission("project:read"), proj.Get)
	authed.GET("/projects/:id/board", mw.RequirePermission("project:read"), proj.Board)
	authed.POST("/projects/:id/milestones", mw.RequirePermission("milestone:write"), proj.AddMilestone)
	authed.POST("/projects/:id/tasks", mw.RequirePermission("task:write"), proj.AddTask)
	authed.POST("/projects/:id/risk/recalculate", mw.RequirePermission("risk:write"), proj.RecalculateRisk)
	authed.PUT("/projects/:id/links", mw.RequirePermission("project:write"), proj.UpdateLinks)
	authed.POST("/projects/:id/log/:kind", mw.RequirePermission("project:write"), proj.AppendLog)
	authed.PATCH("/projects/:id/log/:kind/:itemId", mw.RequirePermission("project:write"), proj.PatchLog)
	authed.PUT("/projects/:id/checkpoints", mw.RequirePermission("project:write"), proj.SetCheckpoints)
	authed.POST("/projects/:id/archive", mw.RequirePermission("project:write"), proj.Archive)
	authed.GET("/settings/archived-projects", proj.ListArchived)
	authed.POST("/projects/:id/restore", proj.Restore)

	wf := handlers.NewWorkforce(d.DB)
	authed.GET("/workforce/load", mw.RequirePermission("workforce:read"), wf.Load)
	authed.GET("/workforce/burnout", mw.RequirePermission("workforce:read"), wf.Burnout)
	authed.POST("/workforce/time-entries", mw.RequirePermission("time_entry:write"), wf.LogTime)

	fin := handlers.NewFinance(d.DB)
	authed.GET("/finance/invoices", mw.RequirePermission("invoice:read"), fin.ListInvoices)
	authed.POST("/finance/invoices", mw.RequirePermission("invoice:write"), fin.CreateInvoice)
	authed.POST("/finance/payments", mw.RequirePermission("payment:write"), fin.RecordPayment)
	authed.GET("/finance/receivables", mw.RequirePermission("invoice:read"), fin.Receivables)
	authed.GET("/finance/summary",     mw.RequirePermission("invoice:read"), fin.Summary)
	authed.GET("/finance/billable",    mw.RequirePermission("invoice:read"), fin.Billable)
	authed.PATCH("/finance/invoices/:id/status", mw.RequirePermission("invoice:write"), fin.UpdateInvoiceStatus)
	authed.POST("/finance/invoices/lookup-irn",  mw.RequirePermission("invoice:read"),  fin.LookupIRN)

	gov := handlers.NewGovernance(d.DB)
	authed.GET("/governance/policies", mw.RequirePermission("policy:read"), gov.ListPolicies)
	authed.POST("/governance/policies", mw.RequirePermission("policy:write"), gov.UpsertPolicy)
	authed.GET("/audit", mw.RequirePermission("audit:read"), gov.Audit)

	an := handlers.NewAnalytics(d.DB)
	authed.GET("/analytics/executive", mw.RequirePermission("analytics:read"), an.Executive)
	authed.GET("/analytics/portfolio-health", mw.RequirePermission("analytics:read"), an.PortfolioHealth)

	gh := handlers.NewGitHub(d.DB, d.Cfg)
	authed.POST("/integrations/github/link", mw.RequirePermission("project:write"), gh.LinkRepo)
	api.POST("/integrations/github/webhook", gh.Webhook)

	ws := handlers.NewWS(d.Redis)
	authed.GET("/ws", ws.Handle)

	return r
}
