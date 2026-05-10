import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Pill } from "@/components/ui";
const COLS = ["todo", "in_progress", "review", "done"];
export function ProjectBoard() {
    const { id } = useParams();
    const { data } = useQuery({
        queryKey: ["board", id], queryFn: () => api(`/api/v1/projects/${id}/board`),
    });
    return (_jsx("div", { className: "grid grid-cols-4 gap-4", children: COLS.map((c) => (_jsx(Card, { title: c.replace("_", " "), children: _jsxs("div", { className: "space-y-2", children: [(data?.columns?.[c] ?? []).map((t) => (_jsxs("div", { className: "card p-3", children: [_jsx("div", { className: "text-sm", children: t.title }), _jsx("div", { className: "mt-2", children: _jsxs(Pill, { children: ["P", t.priority] }) })] }, t.id))), (data?.columns?.[c]?.length ?? 0) === 0 && (_jsx("div", { className: "text-xs text-muted", children: "No tasks" }))] }) }, c))) }));
}
