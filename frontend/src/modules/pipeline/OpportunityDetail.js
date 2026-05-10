import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Pill } from "@/components/ui";
export function OpportunityDetail() {
    const { id } = useParams();
    const qc = useQueryClient();
    const { data } = useQuery({
        queryKey: ["opp", id], queryFn: () => api(`/api/v1/opportunities/${id}`),
    });
    const submit = useMutation({
        mutationFn: () => api(`/api/v1/opportunities/${id}/submit`, { method: "POST" }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["opp", id] }),
    });
    if (!data)
        return _jsx("div", { className: "text-muted", children: "Loading\u2026" });
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "h1", children: data.title }), _jsxs("div", { className: "flex gap-2 mt-1", children: [_jsx(Pill, { children: data.lead_type }), _jsx(Pill, { tone: "info", children: data.stage })] })] }), _jsx("button", { className: "btn-primary", onClick: () => submit.mutate(), children: "Submit for review" })] }), submit.error && (_jsx(Card, { title: "Governance blocked submission", children: _jsx("pre", { className: "text-xs", children: JSON.stringify(submit.error.body, null, 2) }) })), _jsxs("div", { className: "grid grid-cols-2 gap-6", children: [_jsx(Card, { title: "Scope", children: _jsx("p", { className: "text-sm whitespace-pre-wrap", children: data.technical_scope || "—" }) }), _jsx(Card, { title: "Proposal", children: _jsx("p", { className: "text-sm whitespace-pre-wrap", children: data.proposal_summary || "—" }) })] })] }));
}
