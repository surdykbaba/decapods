import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Card } from "@/components/ui";
export function GitHubPage() {
    return (_jsxs("div", { className: "space-y-6", children: [_jsx("h1", { className: "h1", children: "GitHub integration" }), _jsx(Card, { title: "How to connect", children: _jsxs("ol", { className: "text-sm space-y-2 list-decimal pl-5 text-muted", children: [_jsx("li", { children: "Create a GitHub App and install it on your organization." }), _jsxs("li", { children: ["Configure ", _jsx("code", { className: "text-text", children: "GITHUB_APP_ID" }), ", ", _jsx("code", { className: "text-text", children: "GITHUB_APP_PRIVATE_KEY_PATH" }), ", and ", _jsx("code", { className: "text-text", children: "GITHUB_WEBHOOK_SECRET" }), " in the API."] }), _jsx("li", { children: "Link a repository to a project from the project page." }), _jsx("li", { children: "Webhooks flow into the audit log and feed engineering KPIs and burnout signals." })] }) })] }));
}
