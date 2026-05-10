import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { LayoutDashboard, Briefcase, FolderKanban, Users, DollarSign, ShieldCheck, Github, Settings, LogOut, Bell, Search, } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useEffect } from "react";
import { api } from "@/lib/api";
const nav = [
    { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { to: "/pipeline", label: "Pipeline", icon: Briefcase },
    { to: "/projects", label: "Projects", icon: FolderKanban },
    { to: "/workforce", label: "Workforce", icon: Users },
    { to: "/finance", label: "Finance", icon: DollarSign },
    { to: "/governance/policies", label: "Governance", icon: ShieldCheck },
    { to: "/integrations/github", label: "GitHub", icon: Github },
    { to: "/admin/users", label: "Admin", icon: Settings },
];
export function Shell() {
    const { user, setUser, logout } = useAuth();
    const nav2 = useNavigate();
    useEffect(() => {
        if (!user)
            api("/api/v1/me").then(setUser).catch(() => { });
    }, [user, setUser]);
    return (_jsxs("div", { className: "h-full grid", style: { gridTemplateColumns: "240px 1fr" }, children: [_jsxs("aside", { className: "border-r border-border bg-surface flex flex-col", children: [_jsxs("div", { className: "px-5 py-4 border-b border-border", children: [_jsx("div", { className: "text-sm font-bold tracking-wider", children: "PGDP" }), _jsx("div", { className: "text-xs text-muted", children: "Governance & Delivery" })] }), _jsx("nav", { className: "flex-1 px-2 py-3 space-y-0.5", children: nav.map((n) => (_jsxs(NavLink, { to: n.to, className: ({ isActive }) => `flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${isActive ? "bg-border/60 text-text" : "text-muted hover:bg-border/30 hover:text-text"}`, children: [_jsx(n.icon, { size: 16 }), n.label] }, n.to))) }), _jsxs("div", { className: "p-3 border-t border-border text-xs text-muted", children: ["v0.1.0 \u2022 ", import.meta.env.MODE] })] }), _jsxs("main", { className: "flex flex-col min-h-0", children: [_jsxs("header", { className: "h-14 px-5 border-b border-border bg-surface flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center gap-2 text-muted", children: [_jsx(Search, { size: 16 }), _jsx("input", { className: "bg-transparent outline-none text-sm w-64", placeholder: "Search \u2318K" })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx("button", { className: "btn-ghost", children: _jsx(Bell, { size: 16 }) }), _jsxs("div", { className: "text-sm", children: [_jsx("div", { children: user?.name ?? "—" }), _jsx("div", { className: "text-xs text-muted", children: user?.roles?.join(", ") })] }), _jsx("button", { className: "btn-ghost", onClick: () => { logout(); nav2("/login"); }, children: _jsx(LogOut, { size: 16 }) })] })] }), _jsx("div", { className: "flex-1 overflow-auto p-6", children: _jsx(Outlet, {}) })] })] }));
}
