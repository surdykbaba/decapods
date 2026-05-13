package middleware

import (
	"net/http"
	"strings"
	"time"

	"github.com/decapods/pgdp/backend/internal/auth"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const (
	CtxUserID   = "ctx.user_id"
	CtxTenantID = "ctx.tenant_id"
	CtxRoles    = "ctx.roles"
)

func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader("X-Request-ID")
		if id == "" {
			id = uuid.NewString()
		}
		c.Writer.Header().Set("X-Request-ID", id)
		c.Set("request_id", id)
		c.Next()
	}
}

func AccessLog() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		gin.DefaultWriter.Write([]byte(
			c.Request.Method + " " + c.Request.URL.Path + " " +
				http.StatusText(c.Writer.Status()) + " " +
				time.Since(start).String() + "\n",
		))
	}
}

func RequireAuth(secret []byte) gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
			return
		}
		claims, err := auth.Parse(strings.TrimPrefix(h, "Bearer "), secret)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}
		c.Set(CtxUserID, claims.UserID)
		c.Set(CtxTenantID, claims.TenantID)
		c.Set(CtxRoles, claims.Roles)
		c.Next()
	}
}

// RequirePermission gates a route on either the exact perm OR its
// :self-scoped sibling. The :self check is the convention this app
// uses for "you can do this for your own row but not anyone else's"
// — engineer / designer / qa / intern / client_viewer all carry
// scopes like project:read:self and time_entry:write:self. Letting
// :self past the middleware leaves the handler free to apply the
// per-row narrowing (which most of them already do because every
// write defaults UserID = caller).
func RequirePermission(perm string) gin.HandlerFunc {
	selfPerm := perm + ":self"
	return func(c *gin.Context) {
		roles, _ := c.Get(CtxRoles)
		rs, _ := roles.([]string)
		if !auth.HasPermission(rs, perm) && !auth.HasPermission(rs, selfPerm) {
			// The user-facing copy stays human; `required` is kept as a hidden
			// hint for admins debugging from the network panel.
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error":    "You don't have permission to do this. Ask your admin if you need access.",
				"required": perm,
			})
			return
		}
		c.Next()
	}
}
