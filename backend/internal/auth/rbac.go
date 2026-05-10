package auth

// Permission tuples are resource:action[:scope].
// Roles map to permission sets; the loader can be replaced with Casbin for
// dynamic policy. Defaults below provide a sensible starting matrix.

var DefaultRolePermissions = map[string][]string{
	"super_admin":       {"*"},
	"ceo":               {"*:read", "approval:write", "analytics:read"},
	"coo":               {"*:read", "approval:write", "analytics:read"},
	"finance":           {"finance:*", "project:read", "invoice:*", "payment:*", "analytics:read"},
	"hr":                {"workforce:*", "user:read", "analytics:read"},
	"hr_manager":        {"workforce:*", "user:*", "governance:write", "analytics:read", "approval:write"},
	"business_dev":      {"opportunity:*", "client:*", "project:read", "document:write"},
	"delivery_manager":  {"project:*", "task:*", "milestone:*", "workforce:read", "risk:write"},
	"project_manager":   {"project:write:self", "task:*:self", "milestone:*:self", "document:write:self"},
	"engineer":          {"project:read:self", "task:write:self", "time_entry:write:self"},
	"qa":                {"project:read:self", "task:write:self", "qa:*:self"},
	"auditor":           {"*:read", "audit:read"},
	"compliance_officer":{"governance:*", "policy:*", "audit:read"},
	"client_viewer":     {"project:read:self", "milestone:read:self"},
}

func HasPermission(roles []string, required string) bool {
	for _, r := range roles {
		for _, p := range DefaultRolePermissions[r] {
			if p == "*" || p == required || matchesGlob(p, required) {
				return true
			}
		}
	}
	return false
}

func matchesGlob(pattern, value string) bool {
	// Supports prefix:* and *:suffix and resource:* matches.
	if pattern == value {
		return true
	}
	if len(pattern) > 2 && pattern[len(pattern)-2:] == ":*" {
		prefix := pattern[:len(pattern)-1]
		return len(value) >= len(prefix) && value[:len(prefix)] == prefix
	}
	return false
}
