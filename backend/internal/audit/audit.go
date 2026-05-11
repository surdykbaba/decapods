// Package audit is the single entry point for writing audit_log rows.
// Handlers call audit.Write(...) right after a state change; the helper is
// best-effort (it never returns an error to the caller — audit failures must
// not break business actions).
package audit

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Write records a single audit entry. `diff` is optional structured data
// describing what changed (old/new values, request payload, etc.). Failures
// are logged only — never returned. Skips silently when actorID is nil so
// public/system actions don't blow up.
func Write(
	ctx context.Context,
	db *pgxpool.Pool,
	tenantID uuid.UUID,
	actorID *uuid.UUID,
	action, entity string,
	entityID uuid.UUID,
	diff any,
) {
	writeRow(ctx, db, tenantID, actorID, action, entity, entityID, diff, "", "", "", "")
}

// WriteHTTP is the request-aware variant. It pulls the client IP, user-agent,
// HTTP method, and request path off the gin.Context so every audit row in the
// system trail can answer "who did what, from where, against which endpoint."
// Falls back to the plain Write semantics when c is nil.
func WriteHTTP(
	ctx context.Context,
	db *pgxpool.Pool,
	c *gin.Context,
	tenantID uuid.UUID,
	actorID *uuid.UUID,
	action, entity string,
	entityID uuid.UUID,
	diff any,
) {
	ip, ua, method, path := "", "", "", ""
	if c != nil {
		ip = c.ClientIP()
		ua = c.Request.UserAgent()
		method = c.Request.Method
		path = c.Request.URL.Path
	}
	writeRow(ctx, db, tenantID, actorID, action, entity, entityID, diff, ip, ua, method, path)
}

func writeRow(
	ctx context.Context,
	db *pgxpool.Pool,
	tenantID uuid.UUID,
	actorID *uuid.UUID,
	action, entity string,
	entityID uuid.UUID,
	diff any,
	ip, ua, method, path string,
) {
	if db == nil || tenantID == uuid.Nil {
		return
	}
	payload, _ := json.Marshal(diff)
	if payload == nil || string(payload) == "null" {
		payload = []byte("{}")
	}
	_, err := db.Exec(ctx, `
		INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, diff,
		                       ip, user_agent, request_method, request_path)
		VALUES ($1,$2,$3,$4,$5,$6,
		        NULLIF($7,''), NULLIF($8,''), NULLIF($9,''), NULLIF($10,''))`,
		tenantID, actorID, action, entity, entityID, payload,
		ip, ua, method, path)
	if err != nil {
		slog.Warn("audit write failed", "action", action, "entity", entity, "err", err)
	}
}
