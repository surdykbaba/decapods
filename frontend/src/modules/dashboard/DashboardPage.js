import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Stat, Pill } from "@/components/ui";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, BarChart, Bar, CartesianGrid, } from "recharts";
const fakeTrend = Array.from({ length: 12 }).map((_, i) => ({
    m: `M${i + 1}`,
    invoiced: 120 + Math.round(Math.random() * 80),
    paid: 80 + Math.round(Math.random() * 60),
}));
export function DashboardPage() {
    const { data, isLoading } = useQuery({
        queryKey: ["analytics", "executive"],
        queryFn: () => api("/api/v1/analytics/executive"),
    });
    const fmt = (n) => (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const pct = (n) => `${Math.round((n ?? 0) * 100)}%`;
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex items-end justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "h1", children: "Executive overview" }), _jsx("p", { className: "text-sm text-muted", children: "Portfolio, revenue, governance, and workforce \u2014 at a glance." })] }), _jsx(Pill, { tone: "info", children: "Live \u2022 refresh 5m" })] }), _jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4", children: [_jsx(Stat, { label: "Total projects", value: isLoading ? "…" : fmt(data?.portfolio.total) }), _jsx(Stat, { label: "Delayed", value: isLoading ? "…" : fmt(data?.portfolio.delayed), tone: (data?.portfolio.delayed ?? 0) > 0 ? "warn" : "good" }), _jsx(Stat, { label: "At risk", value: isLoading ? "…" : fmt(data?.portfolio.at_risk), tone: (data?.portfolio.at_risk ?? 0) > 0 ? "bad" : "good" }), _jsx(Stat, { label: "Avg utilization", value: isLoading ? "…" : pct(data?.workforce.avg_utilization) })] }), _jsxs("div", { className: "grid grid-cols-1 lg:grid-cols-3 gap-4", children: [_jsx(Card, { title: "Revenue trend", className: "lg:col-span-2", children: _jsx("div", { className: "h-64", children: _jsx(ResponsiveContainer, { children: _jsxs(LineChart, { data: fakeTrend, children: [_jsx(CartesianGrid, { stroke: "rgb(var(--border))", strokeDasharray: "3 3" }), _jsx(XAxis, { dataKey: "m", stroke: "rgb(var(--muted))", fontSize: 12 }), _jsx(YAxis, { stroke: "rgb(var(--muted))", fontSize: 12 }), _jsx(Tooltip, { contentStyle: { background: "rgb(var(--surface))", border: "1px solid rgb(var(--border))" } }), _jsx(Line, { type: "monotone", dataKey: "invoiced", stroke: "rgb(var(--accent))", strokeWidth: 2, dot: false }), _jsx(Line, { type: "monotone", dataKey: "paid", stroke: "rgb(var(--success))", strokeWidth: 2, dot: false })] }) }) }) }), _jsx(Card, { title: "Governance", children: _jsxs("div", { className: "space-y-3", children: [_jsx(Row, { label: "Open violations", value: data?.governance.open_violations, tone: "bad" }), _jsx(Row, { label: "SLA breaches", value: data?.governance.sla_breaches, tone: "warn" }), _jsx(Row, { label: "Pending approvals", value: data?.governance.pending_approvals, tone: "info" })] }) })] }), _jsx(Card, { title: "Receivables (mock)", children: _jsx("div", { className: "h-56", children: _jsx(ResponsiveContainer, { children: _jsxs(BarChart, { data: [
                                { b: "current", v: 120 },
                                { b: "0-30", v: 60 },
                                { b: "31-60", v: 35 },
                                { b: "61-90", v: 18 },
                                { b: "90+", v: 9 },
                            ], children: [_jsx(CartesianGrid, { stroke: "rgb(var(--border))", strokeDasharray: "3 3" }), _jsx(XAxis, { dataKey: "b", stroke: "rgb(var(--muted))", fontSize: 12 }), _jsx(YAxis, { stroke: "rgb(var(--muted))", fontSize: 12 }), _jsx(Tooltip, { contentStyle: { background: "rgb(var(--surface))", border: "1px solid rgb(var(--border))" } }), _jsx(Bar, { dataKey: "v", fill: "rgb(var(--accent))", radius: [6, 6, 0, 0] })] }) }) }) })] }));
}
function Row({ label, value, tone }) {
    return (_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "text-sm text-muted", children: label }), _jsx(Pill, { tone: tone, children: value ?? 0 })] }));
}
