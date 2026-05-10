// Package notifications provides a tiny in-app notification system. Inserts
// rows into the notifications table that the frontend bell pulls.
package notifications

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type N struct {
	Kind  string
	Title string
	Body  string
	Link  string
}

// Notify inserts one row per user that should see the notification. Failures
// are swallowed so notification problems never break the action that fired
// them; callers should check err only for diagnostic logging.
func Notify(ctx context.Context, db *pgxpool.Pool, tenantID uuid.UUID, userIDs []uuid.UUID, n N) error {
	if len(userIDs) == 0 {
		return nil
	}
	for _, uid := range userIDs {
		if uid == uuid.Nil {
			continue
		}
		if _, err := db.Exec(ctx, `
			INSERT INTO notifications (tenant_id, user_id, kind, title, body, link)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			tenantID, uid, n.Kind, n.Title, n.Body, n.Link); err != nil {
			return err
		}
	}
	return nil
}

// Recipients returns the set of user IDs who should hear about a tenant-wide
// event. Currently: every user with a role granting opportunity:write (i.e.
// super_admin, ceo, business_dev). Plus an explicit `also` list (e.g. the
// creator) merged in deduped.
func Recipients(ctx context.Context, db *pgxpool.Pool, tenantID uuid.UUID, also ...uuid.UUID) []uuid.UUID {
	rows, err := db.Query(ctx, `
		SELECT DISTINCT u.id
		FROM users u
		JOIN user_roles ur ON ur.user_id = u.id
		JOIN roles r ON r.id = ur.role_id
		WHERE u.tenant_id = $1
		  AND r.name IN ('super_admin','ceo','compliance_officer','business_dev','delivery_manager')`,
		tenantID)
	if err != nil {
		return also
	}
	defer rows.Close()
	seen := map[uuid.UUID]bool{}
	out := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	for _, id := range also {
		if id != uuid.Nil && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}
