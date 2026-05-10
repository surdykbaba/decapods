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
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/mfa" element={<MfaPage />} />
      <Route element={<RequireAuth><Shell /></RequireAuth>}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/pipeline" element={<PipelinePage />} />
        <Route path="/pipeline/new" element={<OpportunityWizard />} />
        <Route path="/pipeline/:id" element={<OpportunityDetail />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectShell />}>
          <Route index element={<ProjectOverview />} />
          <Route path="board" element={<ProjectBoard />} />
        </Route>
        <Route path="/workforce" element={<WorkforcePage />} />
        <Route path="/workforce/burnout" element={<BurnoutPage />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/finance/invoices" element={<InvoicesPage />} />
        <Route path="/governance/policies" element={<GovernancePoliciesPage />} />
        <Route path="/governance/audit" element={<AuditPage />} />
        <Route path="/integrations/github" element={<GitHubPage />} />
        <Route path="/admin/users" element={<AdminUsersPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
