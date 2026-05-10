import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { NavLink, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Pill } from "@/components/ui";
export function ProjectShell() {
    const { id } = useParams();
    const { data } = useQuery({
        queryKey: ["project", id], queryFn: () => api(`/api/v1/projects/${id}`),
    });
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs text-muted", children: data?.code }), _jsx("h1", { className: "h1", children: data?.name ?? "Project" }), _jsxs("div", { className: "flex gap-2 mt-2", children: [data?.status && _jsx(Pill, { children: data.status }), data?.health && _jsx(Pill, { tone: data.health === "green" ? "good" : data.health === "amber" ? "warn" : "bad", children: data.health })] })] }), _jsx("nav", { className: "flex gap-6 border-b border-border text-sm", children: [
                    { to: ".", label: "Overview", end: true },
                    { to: "board", label: "Board" },
                ].map((t) => (_jsx(NavLink, { to: t.to, end: t.end, className: ({ isActive }) => `pb-3 -mb-px border-b-2 ${isActive ? "border-accent text-text" : "border-transparent text-muted hover:text-text"}`, children: t.label }, t.to))) }), _jsx(Outlet, {})] }));
}
