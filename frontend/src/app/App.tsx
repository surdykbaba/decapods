import { Routes, Route, Navigate } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { Toaster } from "@/components/Toaster";
import { RequireAuth } from "@/app/RequireAuth";
import { LoginPage } from "@/modules/auth/LoginPage";
import { MfaPage } from "@/modules/auth/MfaPage";
import { DashboardPage } from "@/modules/dashboard/DashboardPage";
import { OverviewPage } from "@/modules/overview/OverviewPage";
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
import { WorkflowPage } from "@/modules/settings/WorkflowPage";
import { TeamRatesPage } from "@/modules/settings/TeamRatesPage";
import { MyWorkPage } from "@/modules/me/MyWorkPage";
import { ArchivedProjectsPage } from "@/modules/settings/ArchivedProjectsPage";
import {
  SettingsLayout, SettingsGeneralPage, SettingsMembersStub, SettingsNotificationsStub,
} from "@/modules/settings/SettingsLayout";

export function App() {
  return (
    <>
    <Toaster />
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/mfa" element={<MfaPage />} />
      <Route element={<RequireAuth><Shell /></RequireAuth>}>
        <Route path="/" element={<Navigate to="/my-work" replace />} />
        <Route path="/overview" element={<Navigate to="/my-work" replace />} />
        <Route path="/dashboard" element={<Navigate to="/my-work" replace />} />
        <Route path="/my-work" element={<MyWorkPage />} />
        <Route path="/pipeline" element={<PipelinePage />} />
        <Route path="/pipeline/new" element={<OpportunityWizard />} />
        <Route path="/pipeline/:id" element={<OpportunityDetail />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectShell />}>
          <Route index element={<ProjectOverview />} />
          <Route path="board" element={<ProjectBoard />} />
          <Route path="details" element={<Navigate to=".." replace relative="path" />} />
        </Route>
        <Route path="/workforce" element={<WorkforcePage />} />
        <Route path="/workforce/burnout" element={<BurnoutPage />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/finance/invoices" element={<InvoicesPage />} />

        {/* Unified settings */}
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<SettingsGeneralPage />} />
          <Route path="workflow"   element={<WorkflowPage />} />
          <Route path="team-rates" element={<TeamRatesPage />} />
          <Route path="governance" element={<GovernancePoliciesPage />} />
          <Route path="audit"      element={<AuditPage />} />
          <Route path="archived-projects" element={<ArchivedProjectsPage />} />
          <Route path="integrations/github" element={<GitHubPage />} />
          <Route path="members"    element={<SettingsMembersStub />} />
          <Route path="notifications" element={<SettingsNotificationsStub />} />
        </Route>

        {/* Legacy redirects so old links still work */}
        <Route path="/governance/policies" element={<Navigate to="/settings/governance" replace />} />
        <Route path="/governance/audit"    element={<Navigate to="/settings/audit" replace />} />
        <Route path="/integrations/github" element={<Navigate to="/settings/integrations/github" replace />} />

        <Route path="/admin/users" element={<AdminUsersPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
