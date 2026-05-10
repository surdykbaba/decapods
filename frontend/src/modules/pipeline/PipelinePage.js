import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Pill, Empty, Skeleton } from "@/components/ui";
import { Plus } from "lucide-react";
const STAGES = [
    "new_request", "under_review", "approved", "contracting", "planning",
    "in_progress", "qa_review", "client_acceptance", "invoiced", "paid", "closed",
];
export function PipelinePage() {
    const { data, isLoading } = useQuery({
        queryKey: ["opps"], queryFn: () => api("/api/v1/opportunities"),
    });
    const grouped = STAGES.map((s) => ({
        stage: s,
        items: (data?.items ?? []).filter((o) => o.stage === s),
    }));
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "h1", children: "Pipeline" }), _jsx("p", { className: "text-sm text-muted", children: "From request to closed engagement, gated by governance." })] }), _jsxs(Link, { to: "/pipeline/new", className: "btn-primary", children: [_jsx(Plus, { size: 16 }), "New opportunity"] })] }), isLoading ? (_jsx("div", { className: "grid grid-cols-3 gap-4", children: Array.from({ length: 6 }).map((_, i) => _jsx(Skeleton, { className: "h-32" }, i)) })) : (data?.items?.length ?? 0) === 0 ? (_jsx(Empty, { title: "No opportunities yet", body: "Create your first opportunity to begin governance." })) : (_jsx("div", { className: "overflow-x-auto", children: _jsx("div", { className: "grid gap-4", style: { gridTemplateColumns: `repeat(${STAGES.length}, minmax(240px, 1fr))` }, children: grouped.map((col) => (_jsxs("div", { className: "card p-3 min-h-[200px]", children: [_jsxs("div", { className: "flex items-center justify-between mb-3", children: [_jsx("div", { className: "text-xs uppercase tracking-wide text-muted", children: col.stage.replaceAll("_", " ") }), _jsx(Pill, { children: col.items.length })] }), _jsx("div", { className: "space-y-2", children: col.items.map((o) => (_jsxs(Link, { to: `/pipeline/${o.id}`, className: "block card p-3 hover:border-accent transition", children: [_jsx("div", { className: "text-sm font-medium", children: o.title }), _jsxs("div", { className: "text-xs text-muted mt-1", children: [o.lead_type, " \u2022 $", (o.estimated_value || 0).toLocaleString()] }), _jsxs("div", { className: "mt-2 flex gap-1", children: [o.risk_level && _jsx(Pill, { tone: o.risk_level === "high" ? "bad" : "warn", children: o.risk_level }), _jsxs(Pill, { children: ["P", o.priority] })] })] }, o.id))) })] }, col.stage))) }) }))] }));
}
