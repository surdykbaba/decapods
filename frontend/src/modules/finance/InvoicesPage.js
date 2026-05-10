import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Pill } from "@/components/ui";
export function InvoicesPage() {
    const { data } = useQuery({
        queryKey: ["invoices"], queryFn: () => api("/api/v1/finance/invoices"),
    });
    return (_jsxs("div", { className: "space-y-6", children: [_jsx("h1", { className: "h1", children: "Invoices" }), _jsx(Card, { children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "text-left text-muted text-xs uppercase", children: _jsxs("tr", { children: [_jsx("th", { className: "py-2", children: "Number" }), _jsx("th", { children: "Amount" }), _jsx("th", { children: "Status" }), _jsx("th", { children: "Due" })] }) }), _jsx("tbody", { children: (data?.items ?? []).map((i) => (_jsxs("tr", { className: "border-t border-border", children: [_jsx("td", { className: "py-3 font-mono", children: i.number }), _jsxs("td", { children: [i.currency, " ", i.amount.toLocaleString()] }), _jsx("td", { children: _jsx(Pill, { tone: i.status === "paid" ? "good" : i.status === "draft" ? "neutral" : "warn", children: i.status }) }), _jsx("td", { children: i.due_on ?? "—" })] }, i.id))) })] }) })] }));
}
