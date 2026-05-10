package handlers

import (
	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/workforce"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Workforce struct {
	db  *pgxpool.Pool
	svc *workforce.Service
}

func NewWorkforce(db *pgxpool.Pool) *Workforce {
	return &Workforce{db: db, svc: workforce.New(db)}
}

func (h *Workforce) Load(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	out, err := h.svc.LoadHeatmap(c, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, out)
}

func (h *Workforce) Burnout(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	out, err := h.svc.BurnoutWatchlist(c, tid)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, out)
}

func (h *Workforce) LogTime(c *gin.Context) {
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)
	var req workforce.TimeEntryInput
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	req.UserID = uid
	id, err := h.svc.LogTime(c, req)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": id})
}
