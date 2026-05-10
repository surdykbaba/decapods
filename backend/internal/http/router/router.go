package router

import (
	"log/slog"
	"net/http"

	"github.com/decapods/pgdp/backend/internal/http/handlers"
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
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
	authed.POST("/opportunities/:id/submit", mw.RequirePermission("opportunity:write"), opp.Submit)
	authed.POST("/opportunities/:id/transition", mw.RequirePermission("opportunity:write"), opp.Transition)
	authed.POST("/opportunities/:id/documents", mw.RequirePermission("document:write"), opp.AttachDocument)

	proj := handlers.NewProjects(d.DB)
	authed.GET("/projects", mw.RequirePermission("project:read"), proj.List)
	authed.POST("/projects", mw.RequirePermission("project:write"), proj.Create)
	authed.GET("/projects/:id", mw.RequirePermission("project:read"), proj.Get)
	authed.GET("/projects/:id/board", mw.RequirePermission("project:read"), proj.Board)
	authed.POST("/projects/:id/milestones", mw.RequirePermission("milestone:write"), proj.AddMilestone)
	authed.POST("/projects/:id/tasks", mw.RequirePermission("task:write"), proj.AddTask)
	authed.POST("/projects/:id/risk/recalculate", mw.RequirePermission("risk:write"), proj.RecalculateRisk)

	wf := handlers.NewWorkforce(d.DB)
	authed.GET("/workforce/load", mw.RequirePermission("workforce:read"), wf.Load)
	authed.GET("/workforce/burnout", mw.RequirePermission("workforce:read"), wf.Burnout)
	authed.POST("/workforce/time-entries", mw.RequirePermission("time_entry:write"), wf.LogTime)

	fin := handlers.NewFinance(d.DB)
	authed.GET("/finance/invoices", mw.RequirePermission("invoice:read"), fin.ListInvoices)
	authed.POST("/finance/invoices", mw.RequirePermission("invoice:write"), fin.CreateInvoice)
	authed.POST("/finance/payments", mw.RequirePermission("payment:write"), fin.RecordPayment)
	authed.GET("/finance/receivables", mw.RequirePermission("invoice:read"), fin.Receivables)

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
