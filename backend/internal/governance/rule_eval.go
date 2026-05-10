package governance

// evalRule is a tiny JSON-Logic-style evaluator covering the operators we use
// in built-in policies. It is intentionally minimal — production deployments
// should swap in github.com/diegoholiveira/jsonlogic for the full spec.
func evalRule(rule map[string]any, data map[string]any) bool {
	for op, raw := range rule {
		args, _ := raw.([]any)
		switch op {
		case "and":
			for _, a := range args {
				if m, ok := a.(map[string]any); ok && !evalRule(m, data) {
					return false
				}
			}
			return true
		case "or":
			for _, a := range args {
				if m, ok := a.(map[string]any); ok && evalRule(m, data) {
					return true
				}
			}
			return false
		case ">", ">=", "<", "<=", "==", "!=":
			if len(args) != 2 {
				return false
			}
			l, lok := toFloat(resolve(args[0], data))
			r, rok := toFloat(resolve(args[1], data))
			if !lok || !rok {
				return false
			}
			switch op {
			case ">":
				return l > r
			case ">=":
				return l >= r
			case "<":
				return l < r
			case "<=":
				return l <= r
			case "==":
				return l == r
			case "!=":
				return l != r
			}
		case "in":
			if len(args) != 2 {
				return false
			}
			needle := resolve(args[0], data)
			hay, _ := args[1].([]any)
			for _, h := range hay {
				if h == needle {
					return true
				}
			}
			return false
		}
	}
	return false
}

func resolve(v any, data map[string]any) any {
	if m, ok := v.(map[string]any); ok {
		if k, ok := m["var"].(string); ok {
			return data[k]
		}
	}
	return v
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	}
	return 0, false
}
