import { jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
export function RequireAuth({ children, roles }) {
    const { token, user } = useAuth();
    const loc = useLocation();
    if (!token)
        return _jsx(Navigate, { to: "/login", state: { from: loc }, replace: true });
    if (roles && user && !roles.some((r) => user.roles.includes(r))) {
        return _jsx("div", { className: "p-8", children: "Access denied." });
    }
    return _jsx(_Fragment, { children: children });
}
