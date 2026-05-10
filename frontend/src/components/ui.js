import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import clsx from "clsx";
export function Card({ title, children, action, className }) {
    return (_jsxs("div", { className: clsx("card p-5", className), children: [(title || action) && (_jsxs("div", { className: "flex items-center justify-between mb-4", children: [title && _jsx("h3", { className: "h2", children: title }), action] })), children] }));
}
export function Stat({ label, value, hint, tone = "neutral" }) {
    const toneCls = {
        neutral: "text-text",
        good: "text-success",
        warn: "text-warn",
        bad: "text-danger",
    }[tone];
    return (_jsxs("div", { className: "card p-5", children: [_jsx("div", { className: "label", children: label }), _jsx("div", { className: clsx("text-2xl font-semibold", toneCls), children: value }), hint && _jsx("div", { className: "text-xs text-muted mt-1", children: hint })] }));
}
export function Pill({ children, tone = "neutral" }) {
    const cls = {
        neutral: "bg-border/40 text-muted",
        good: "bg-success/15 text-success",
        warn: "bg-warn/15 text-warn",
        bad: "bg-danger/15 text-danger",
        info: "bg-accent/15 text-accent",
    }[tone];
    return _jsx("span", { className: `pill ${cls}`, children: children });
}
export function Empty({ title, body }) {
    return (_jsxs("div", { className: "card p-8 text-center text-muted", children: [_jsx("div", { className: "font-semibold text-text mb-1", children: title }), body && _jsx("div", { className: "text-sm", children: body })] }));
}
export function Skeleton({ className }) {
    return _jsx("div", { className: clsx("animate-pulse bg-border/40 rounded", className) });
}
