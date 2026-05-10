package handlers

import (
	"net/http"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/decapods/pgdp/backend/internal/projects"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Projects struct {
	db  *pgxpool.Pool
	svc *projects.Service
}

func NewProjects(db *pgxpool.Pool) *Projects {
	return &Projects{db: db, svc: projects.NewService(db)}
}

func (h *Projects) List(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	items, err := h.svc.List(c, tid, c.Query("status"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"items": items})
}

func (h *Projects) Create(c *gin.Context) {
	var req projects.CreateInput
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	req.TenantID = c.MustGet(mw.CtxTenantID).(uuid.UUID)
	req.CreatedBy = c.MustGet(mw.CtxUserID).(uuid.UUID)
	id, err := h.svc.Create(c, req)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

func (h *Projects) Get(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	p, err := h.svc.Get(c, id)
	if err != nil {
		c.JSON(404, gin.H{"error": "not found"})
		return
	}
	c.JSON(200, p)
}

func (h *Projects) Board(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	board, err := h.svc.Board(c, id)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, board)
}

func (h *Projects) AddMilestone(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	var req projects.MilestoneInput
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	mid, err := h.svc.AddMilestone(c, id, req)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": mid})
}

func (h *Projects) AddTask(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	var req projects.TaskInput
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	req.CreatedBy = c.MustGet(mw.CtxUserID).(uuid.UUID)
	tid, err := h.svc.AddTask(c, id, req)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"id": tid})
}

func (h *Projects) RecalculateRisk(c *gin.Context) {
	id, _ := uuid.Parse(c.Param("id"))
	score, err := h.svc.RecalculateRisk(c, id)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"risk_score": score})
}
