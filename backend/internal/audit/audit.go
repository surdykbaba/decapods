// Package audit is the single entry point for writing audit_log rows.
// Handlers call audit.Write(...) right after a state change; the helper is
// best-effort (it never returns an error to the caller — audit failures must
// not break business actions).
package audit

import (
	"context"
	"encoding/json"
	"log/slog"

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
	if db == nil || tenantID == uuid.Nil {
		return
	}
	payload, _ := json.Marshal(diff)
	if payload == nil || string(payload) == "null" {
		payload = []byte("{}")
	}
	_, err := db.Exec(ctx, `
		INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, diff)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		tenantID, actorID, action, entity, entityID, payload)
	if err != nil {
		slog.Warn("audit write failed", "action", action, "entity", entity, "err", err)
	}
}
