import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";
export function AuditPage() {
    const { data } = useQuery({
        queryKey: ["audit"], queryFn: () => api("/api/v1/audit"),
    });
    return (_jsxs("div", { className: "space-y-6", children: [_jsx("h1", { className: "h1", children: "Audit log" }), _jsx(Card, { children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "text-left text-muted text-xs uppercase", children: _jsxs("tr", { children: [_jsx("th", { className: "py-2", children: "When" }), _jsx("th", { children: "Actor" }), _jsx("th", { children: "Action" }), _jsx("th", { children: "Entity" })] }) }), _jsx("tbody", { children: (data?.items ?? []).map((r) => (_jsxs("tr", { className: "border-t border-border", children: [_jsx("td", { className: "py-3 text-xs text-muted", children: new Date(r.created_at).toLocaleString() }), _jsx("td", { className: "font-mono text-xs", children: r.actor_id }), _jsx("td", { children: r.action }), _jsxs("td", { children: [r.entity, "/", r.entity_id] })] }, r.id))) })] }) })] }));
}
