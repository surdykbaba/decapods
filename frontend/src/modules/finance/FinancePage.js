import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Stat } from "@/components/ui";
export function FinancePage() {
    const { data } = useQuery({
        queryKey: ["finance", "receivables"], queryFn: () => api("/api/v1/finance/receivables"),
    });
    const a = data?.aging ?? {};
    return (_jsxs("div", { className: "space-y-6", children: [_jsx("h1", { className: "h1", children: "Finance" }), _jsxs("div", { className: "grid grid-cols-5 gap-4", children: [_jsx(Stat, { label: "Current", value: `$${(a.current ?? 0).toLocaleString()}` }), _jsx(Stat, { label: "0-30", value: `$${(a["0_30"] ?? 0).toLocaleString()}` }), _jsx(Stat, { label: "31-60", value: `$${(a["31_60"] ?? 0).toLocaleString()}`, tone: "warn" }), _jsx(Stat, { label: "61-90", value: `$${(a["61_90"] ?? 0).toLocaleString()}`, tone: "warn" }), _jsx(Stat, { label: "90+", value: `$${(a["90_plus"] ?? 0).toLocaleString()}`, tone: "bad" })] }), _jsx(Card, { title: "Notes", children: _jsx("p", { className: "text-sm text-muted", children: "Drill into invoices, payments, P&L, and revenue recognition from the sub-pages." }) })] }));
}
