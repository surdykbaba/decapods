import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";
export function WorkforcePage() {
    const { data } = useQuery({
        queryKey: ["workforce", "load"], queryFn: () => api("/api/v1/workforce/load"),
    });
    const heat = (u) => {
        if (u >= 1.1)
            return "bg-danger/70";
        if (u >= 0.9)
            return "bg-warn/60";
        if (u >= 0.5)
            return "bg-success/50";
        return "bg-border/50";
    };
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { children: [_jsx("h1", { className: "h1", children: "Workforce" }), _jsx("p", { className: "text-sm text-muted", children: "Utilization heatmap \u2014 last 8 weeks." })] }), _jsx(Card, { children: _jsx("div", { className: "overflow-x-auto", children: _jsx("table", { className: "w-full text-xs", children: _jsxs("tbody", { children: [(data?.people ?? []).map((p) => (_jsxs("tr", { className: "border-t border-border", children: [_jsx("td", { className: "py-2 pr-4 whitespace-nowrap text-sm", children: p.name }), p.weeks.map((w) => (_jsx("td", { className: "px-1 py-2", children: _jsx("div", { className: `h-6 w-12 rounded ${heat(w.utilization)}`, title: `${w.hours}h • ${(w.utilization * 100).toFixed(0)}%` }) }, w.week)))] }, p.id))), (data?.people ?? []).length === 0 && (_jsx("tr", { children: _jsx("td", { className: "text-muted py-6", children: "No data yet" }) }))] }) }) }) })] }));
}
