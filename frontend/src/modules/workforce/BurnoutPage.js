import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Pill } from "@/components/ui";
export function BurnoutPage() {
    const { data } = useQuery({
        queryKey: ["workforce", "burnout"], queryFn: () => api("/api/v1/workforce/burnout"),
    });
    const tone = (b) => b === "critical" ? "bad" : b === "elevated" ? "warn" : b === "watch" ? "info" : "good";
    return (_jsxs("div", { className: "space-y-6", children: [_jsx("h1", { className: "h1", children: "Burnout watchlist" }), _jsx(Card, { children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "text-left text-muted text-xs uppercase", children: _jsxs("tr", { children: [_jsx("th", { className: "py-2", children: "Person" }), _jsx("th", { children: "Score" }), _jsx("th", { children: "Band" })] }) }), _jsx("tbody", { children: (data?.watchlist ?? []).map((r) => (_jsxs("tr", { className: "border-t border-border", children: [_jsx("td", { className: "py-3", children: r.name }), _jsx("td", { children: r.score.toFixed(0) }), _jsx("td", { children: _jsx(Pill, { tone: tone(r.band), children: r.band }) })] }, r.user_id))) })] }) })] }));
}
