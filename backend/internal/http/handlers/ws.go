package handlers

import (
	"context"
	"net/http"

	mw "github.com/decapods/pgdp/backend/internal/http/middleware"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

type WS struct {
	rdb *redis.Client
	up  websocket.Upgrader
}

func NewWS(rdb *redis.Client) *WS {
	return &WS{
		rdb: rdb,
		up:  websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }},
	}
}

// Handle subscribes the connection to the tenant's notification channel and
// streams messages until the client disconnects.
func (w *WS) Handle(c *gin.Context) {
	tid := c.MustGet(mw.CtxTenantID).(uuid.UUID)
	uid := c.MustGet(mw.CtxUserID).(uuid.UUID)

	conn, err := w.up.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()

	sub := w.rdb.Subscribe(ctx,
		"tenant:"+tid.String()+":broadcast",
		"tenant:"+tid.String()+":user:"+uid.String(),
	)
	defer sub.Close()
	ch := sub.Channel()

	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-ch:
			if msg == nil {
				return
			}
			if err := conn.WriteMessage(websocket.TextMessage, []byte(msg.Payload)); err != nil {
				return
			}
		}
	}
}
