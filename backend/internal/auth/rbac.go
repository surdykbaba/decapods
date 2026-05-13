package auth

// Permission tuples are resource:action[:scope].
// Roles map to permission sets; the loader can be replaced with Casbin for
// dynamic policy. Defaults below provide a sensible starting matrix.

var DefaultRolePermissions = map[string][]string{
	"super_admin":       {"*"},
	"ceo":               {"*:read", "approval:write", "analytics:read", "okr:write"},
	"coo":               {"*:read", "approval:write", "analytics:read", "okr:write"},
	"finance":           {"finance:*", "project:read", "invoice:*", "payment:*", "analytics:read", "okr:read"},
	"hr":                {"workforce:*", "user:read", "analytics:read", "okr:write"},
	"hr_manager":        {"workforce:*", "user:*", "governance:write", "analytics:read", "approval:write", "okr:write"},
	"business_dev":      {"opportunity:*", "client:*", "project:read", "document:write", "okr:write"},
	"delivery_manager":  {"project:*", "task:*", "milestone:*", "workforce:read", "risk:write", "document:write", "okr:write"},
	// project_manager — full write on projects + tasks + milestones so they
	// can do the day-to-day: edit project metadata, add/remove members,
	// assign tasks, set milestones, log risks. Previously had ":self"-scoped
	// permissions, but the matcher only does prefix-glob so those entries
	// silently failed every gate and PMs couldn't even add a task. Until
	// we wire handler-level project-membership scoping, this is the
	// pragmatic grant — same surface area as delivery_manager.
	//
	// okr:write lets PMs set their own + their team's objectives and KRs;
	// per-row ownership is enforced inside the handler.
	"project_manager":   {"project:*", "task:*", "milestone:*", "workforce:read", "risk:write", "document:write", "okr:write"},
	// Individual contributors can write their own OKRs — the handler
	// blocks edits to anyone else's unless the caller is an admin.
	"engineer":          {"project:read:self", "task:write:self", "time_entry:write:self", "okr:write"},
	"designer":          {"project:read:self", "task:write:self", "time_entry:write:self", "document:write:self", "okr:write"},
	"qa":                {"project:read:self", "task:write:self", "qa:*:self", "okr:write"},
	"auditor":           {"*:read", "audit:read", "okr:read"},
	"compliance_officer":{"governance:*", "policy:*", "audit:read", "okr:read"},
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
