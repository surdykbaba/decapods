import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Card, Pill, Empty } from "@/components/ui";
export function ProjectsPage() {
    const { data } = useQuery({
        queryKey: ["projects"],
        queryFn: () => api("/api/v1/projects").then((r) => r.items),
    });
    return (_jsxs("div", { className: "space-y-6", children: [_jsx("h1", { className: "h1", children: "Projects" }), !data?.length ? _jsx(Empty, { title: "No projects yet" }) : (_jsx(Card, { children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "text-left text-muted text-xs uppercase", children: _jsxs("tr", { children: [_jsx("th", { className: "py-2", children: "Code" }), _jsx("th", { children: "Name" }), _jsx("th", { children: "Status" }), _jsx("th", { children: "Health" }), _jsx("th", { children: "Risk" }), _jsx("th", { children: "Budget" })] }) }), _jsx("tbody", { children: data.map((p) => (_jsxs("tr", { className: "border-t border-border hover:bg-border/20", children: [_jsx("td", { className: "py-3 font-mono text-xs", children: p.code }), _jsx("td", { children: _jsx(Link, { to: `/projects/${p.id}`, className: "hover:underline", children: p.name }) }), _jsx("td", { children: _jsx(Pill, { children: p.status }) }), _jsx("td", { children: _jsx(Pill, { tone: p.health === "green" ? "good" : p.health === "amber" ? "warn" : "bad", children: p.health }) }), _jsx("td", { children: p.risk_score?.toFixed?.(0) ?? 0 }), _jsxs("td", { children: ["$", (p.budget || 0).toLocaleString()] })] }, p.id))) })] }) }))] }));
}
