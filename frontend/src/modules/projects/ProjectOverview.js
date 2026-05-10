import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Stat } from "@/components/ui";
export function ProjectOverview() {
    const { id } = useParams();
    const qc = useQueryClient();
    const recalc = useMutation({
        mutationFn: () => api(`/api/v1/projects/${id}/risk/recalculate`, { method: "POST" }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["project", id] }),
    });
    return (_jsxs("div", { className: "grid grid-cols-2 lg:grid-cols-4 gap-4", children: [_jsx(Stat, { label: "Open tasks", value: "\u2014" }), _jsx(Stat, { label: "Velocity", value: "\u2014" }), _jsx(Stat, { label: "On-time milestones", value: "\u2014" }), _jsx(Stat, { label: "Burn rate", value: "\u2014" }), _jsxs(Card, { className: "col-span-2 lg:col-span-4", title: "Risk", children: [_jsx("p", { className: "text-sm text-muted mb-3", children: "Recompute risk by aggregating delivery, financial, dependency, staffing, and compliance dimensions." }), _jsx("button", { className: "btn-primary", onClick: () => recalc.mutate(), disabled: recalc.isPending, children: recalc.isPending ? "Recomputing…" : "Recalculate risk" })] })] }));
}
