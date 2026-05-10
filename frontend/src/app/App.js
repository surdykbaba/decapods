import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Routes, Route, Navigate } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { RequireAuth } from "@/app/RequireAuth";
import { LoginPage } from "@/modules/auth/LoginPage";
import { MfaPage } from "@/modules/auth/MfaPage";
import { DashboardPage } from "@/modules/dashboard/DashboardPage";
import { PipelinePage } from "@/modules/pipeline/PipelinePage";
import { OpportunityWizard } from "@/modules/pipeline/OpportunityWizard";
import { OpportunityDetail } from "@/modules/pipeline/OpportunityDetail";
import { ProjectsPage } from "@/modules/projects/ProjectsPage";
import { ProjectShell } from "@/modules/projects/ProjectShell";
import { ProjectBoard } from "@/modules/projects/ProjectBoard";
import { ProjectOverview } from "@/modules/projects/ProjectOverview";
import { WorkforcePage } from "@/modules/workforce/WorkforcePage";
import { BurnoutPage } from "@/modules/workforce/BurnoutPage";
import { FinancePage } from "@/modules/finance/FinancePage";
import { InvoicesPage } from "@/modules/finance/InvoicesPage";
import { GovernancePoliciesPage } from "@/modules/governance/PoliciesPage";
import { AuditPage } from "@/modules/governance/AuditPage";
import { GitHubPage } from "@/modules/integrations/GitHubPage";
import { AdminUsersPage } from "@/modules/admin/UsersPage";
export function App() {
    return (_jsxs(Routes, { children: [_jsx(Route, { path: "/login", element: _jsx(LoginPage, {}) }), _jsx(Route, { path: "/mfa", element: _jsx(MfaPage, {}) }), _jsxs(Route, { element: _jsx(RequireAuth, { children: _jsx(Shell, {}) }), children: [_jsx(Route, { path: "/", element: _jsx(Navigate, { to: "/dashboard", replace: true }) }), _jsx(Route, { path: "/dashboard", element: _jsx(DashboardPage, {}) }), _jsx(Route, { path: "/pipeline", element: _jsx(PipelinePage, {}) }), _jsx(Route, { path: "/pipeline/new", element: _jsx(OpportunityWizard, {}) }), _jsx(Route, { path: "/pipeline/:id", element: _jsx(OpportunityDetail, {}) }), _jsx(Route, { path: "/projects", element: _jsx(ProjectsPage, {}) }), _jsxs(Route, { path: "/projects/:id", element: _jsx(ProjectShell, {}), children: [_jsx(Route, { index: true, element: _jsx(ProjectOverview, {}) }), _jsx(Route, { path: "board", element: _jsx(ProjectBoard, {}) })] }), _jsx(Route, { path: "/workforce", element: _jsx(WorkforcePage, {}) }), _jsx(Route, { path: "/workforce/burnout", element: _jsx(BurnoutPage, {}) }), _jsx(Route, { path: "/finance", element: _jsx(FinancePage, {}) }), _jsx(Route, { path: "/finance/invoices", element: _jsx(InvoicesPage, {}) }), _jsx(Route, { path: "/governance/policies", element: _jsx(GovernancePoliciesPage, {}) }), _jsx(Route, { path: "/governance/audit", element: _jsx(AuditPage, {}) }), _jsx(Route, { path: "/integrations/github", element: _jsx(GitHubPage, {}) }), _jsx(Route, { path: "/admin/users", element: _jsx(AdminUsersPage, {}) })] }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/", replace: true }) })] }));
}
