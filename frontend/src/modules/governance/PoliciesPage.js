import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Pill, Empty } from "@/components/ui";
export function GovernancePoliciesPage() {
    const { data } = useQuery({
        queryKey: ["policies"], queryFn: () => api("/api/v1/governance/policies"),
    });
    return (_jsxs("div", { className: "space-y-6", children: [_jsx("h1", { className: "h1", children: "Governance policies" }), !data?.items?.length ? _jsx(Empty, { title: "No custom policies", body: "Built-in governance rules are active. Add custom JSON-Logic rules per tenant via the API." }) : (_jsx(Card, { children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "text-left text-muted text-xs uppercase", children: _jsxs("tr", { children: [_jsx("th", { className: "py-2", children: "Code" }), _jsx("th", { children: "Kind" }), _jsx("th", { children: "Active" })] }) }), _jsx("tbody", { children: data.items.map((p) => (_jsxs("tr", { className: "border-t border-border", children: [_jsx("td", { className: "py-3 font-mono", children: p.code }), _jsx("td", { children: p.kind }), _jsx("td", { children: _jsx(Pill, { tone: p.active ? "good" : "neutral", children: p.active ? "active" : "off" }) })] }, p.id))) })] }) }))] }));
}
