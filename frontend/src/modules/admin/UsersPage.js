import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Card, Empty } from "@/components/ui";
export function AdminUsersPage() {
    return (_jsxs("div", { className: "space-y-6", children: [_jsx("h1", { className: "h1", children: "Users & roles" }), _jsx(Card, { children: _jsx(Empty, { title: "User management", body: "Provision users, assign roles, and toggle MFA from this page (API ready)." }) })] }));
}
