import { Routes, Route, Navigate } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { Toaster } from "@/components/Toaster";
import { ConfirmHost } from "@/components/ConfirmHost";
import { PwaHooks } from "@/components/PwaHooks";
import { RequireAuth } from "@/app/RequireAuth";
import { LoginPage } from "@/modules/auth/LoginPage";
import { LockScreen } from "@/modules/auth/LockScreen";
import { MfaPage } from "@/modules/auth/MfaPage";
import { ForgotPasswordPage } from "@/modules/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "@/modules/auth/ResetPasswordPage";
import { PipelinePage } from "@/modules/pipeline/PipelinePage";
import { OpportunityWizard } from "@/modules/pipeline/OpportunityWizard";
import { OpportunityDetail } from "@/modules/pipeline/OpportunityDetail";
import { ProjectsPage } from "@/modules/projects/ProjectsPage";
import { ProjectShell } from "@/modules/projects/ProjectShell";
import { ProjectBoard } from "@/modules/projects/ProjectBoard";
import { ProjectOverview } from "@/modules/projects/ProjectOverview";
import { ProjectListTab } from "@/modules/projects/ProjectListTab";
import { ProjectCalendarTab } from "@/modules/projects/ProjectCalendarTab";
import { ProjectFilesTab } from "@/modules/projects/ProjectFilesTab";
import { WorkforcePage } from "@/modules/workforce/WorkforcePage";
import { BurnoutPage } from "@/modules/workforce/BurnoutPage";
import { FinancePage } from "@/modules/finance/FinancePage";
import { PayrollPage } from "@/modules/payroll/PayrollPage";
import { InvoicesPage } from "@/modules/finance/InvoicesPage";
import { GovernancePoliciesPage } from "@/modules/governance/PoliciesPage";
import { AuditPage } from "@/modules/governance/AuditPage";
import { GitHubPage } from "@/modules/integrations/GitHubPage";
import { TeamsPage } from "@/modules/integrations/TeamsPage";
import { MicrosoftCalendarPage } from "@/modules/integrations/MicrosoftCalendarPage";
import { AdminUsersPage } from "@/modules/admin/UsersPage";
import { SystemAuditPage } from "@/modules/admin/SystemAuditPage";
import { DailyCheckinsPage } from "@/modules/admin/DailyCheckinsPage";
import { WorkflowPage } from "@/modules/settings/WorkflowPage";
import { WorkPolicyPage } from "@/modules/settings/WorkPolicyPage";
import { StandupSettingsPage } from "@/modules/settings/StandupSettingsPage";
import { OKRsPage } from "@/modules/okrs/OKRsPage";
import { TeamRatesPage } from "@/modules/settings/TeamRatesPage";
import { RolesPermissionsPage } from "@/modules/settings/RolesPermissionsPage";
import { MyWorkPage } from "@/modules/me/MyWorkPage";
import { FilesPage } from "@/modules/files/FilesPage";
import { LeavePage } from "@/modules/leave/LeavePage";
import { CampfirePage } from "@/modules/campfire/CampfirePage";
import { CampfireUserPage } from "@/modules/campfire/CampfireUserPage";
import { CampfireJoinPage } from "@/modules/campfire/CampfireJoinPage";
import { ColleaguesPage } from "@/modules/colleagues/ColleaguesPage";
import { LegalsPage } from "@/modules/legals/LegalsPage";
import { LearningPage } from "@/modules/learning/LearningPage";
import { AttendancePage } from "@/modules/attendance/AttendancePage";
import { ArchivedProjectsPage } from "@/modules/settings/ArchivedProjectsPage";
import { VendorDetailPage } from "@/modules/vendors/VendorDetailPage";
import { VendorInvitePage } from "@/modules/vendors/VendorInvitePage";
import { AgentDetailPage } from "@/modules/agents/AgentDetailPage";
import { AgentInvitePage } from "@/modules/agents/AgentInvitePage";
import { RelationshipsPage } from "@/modules/relationships/RelationshipsPage";
import {
  SettingsLayout, SettingsGeneralPage, SettingsMembersStub, SettingsNotificationsStub,
} from "@/modules/settings/SettingsLayout";
import { MembersPage } from "@/modules/members/MembersPage";
import { MemberInvitePage } from "@/modules/members/MemberInvitePage";
import { MemberProfilePage } from "@/modules/members/MemberProfilePage";
// Keep parked imports silenced so a future wiring doesn't need the import dance.
void SettingsMembersStub;

export function App() {
  return (
    <>
    <Toaster />
    <ConfirmHost />
    <PwaHooks />
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/lock"  element={<LockScreen />} />
      <Route path="/mfa" element={<MfaPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
      {/* Public, token-gated onboarding pages — no JWT required */}
      <Route path="/vendor-invite/:token" element={<VendorInvitePage />} />
      <Route path="/agent-invite/:token"  element={<AgentInvitePage />} />
      <Route path="/member-invite/:token" element={<MemberInvitePage />} />
      <Route element={<RequireAuth><Shell /></RequireAuth>}>
        <Route path="/" element={<Navigate to="/my-work" replace />} />
        <Route path="/overview" element={<Navigate to="/my-work" replace />} />
        <Route path="/dashboard" element={<Navigate to="/my-work" replace />} />
        <Route path="/my-work" element={<MyWorkPage />} />
        <Route path="/files"   element={<FilesPage />} />
        <Route path="/leave"   element={<LeavePage />} />
        <Route path="/okrs"    element={<OKRsPage />} />
        <Route path="/campfire" element={<CampfirePage />} />
        <Route path="/campfire/u/:id" element={<CampfireUserPage />} />
        <Route path="/campfire/join/:token" element={<CampfireJoinPage />} />
        <Route path="/colleagues" element={<ColleaguesPage />} />
        <Route path="/legals" element={<LegalsPage />} />
        <Route path="/learning" element={<LearningPage />} />
        <Route path="/attendance" element={<AttendancePage />} />
        <Route path="/pipeline" element={<PipelinePage />} />
        <Route path="/pipeline/new" element={<OpportunityWizard />} />
        <Route path="/pipeline/:id" element={<OpportunityDetail />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectShell />}>
          <Route index element={<ProjectOverview />} />
          <Route path="list"     element={<ProjectListTab />} />
          <Route path="board"    element={<ProjectBoard />} />
          <Route path="calendar" element={<ProjectCalendarTab />} />
          <Route path="files"    element={<ProjectFilesTab />} />
          <Route path="details"  element={<Navigate to=".." replace relative="path" />} />
        </Route>
        <Route path="/workforce" element={<WorkforcePage />} />
        <Route path="/workforce/burnout" element={<BurnoutPage />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/payroll" element={<PayrollPage />} />
        <Route path="/finance/invoices" element={<InvoicesPage />} />

        {/* Unified Relationships hub — Stakeholders, Vendors and PR & Agents
            in one page with a tab strip. Old top-level routes redirect with
            their respective ?tab=… so notifications and bookmarks still land
            on the right pane. Detail pages keep their own routes. */}
        <Route path="/relationships" element={<RelationshipsPage />} />
        <Route path="/stakeholders"  element={<Navigate to="/relationships?tab=stakeholders" replace />} />
        <Route path="/vendors"       element={<Navigate to="/relationships?tab=vendors" replace />} />
        <Route path="/agents"        element={<Navigate to="/relationships?tab=agents" replace />} />
        <Route path="/vendors/:id"   element={<VendorDetailPage />} />
        <Route path="/agents/:id"    element={<AgentDetailPage />} />
        <Route path="/members"       element={<MembersPage />} />
        <Route path="/members/:id"   element={<MemberProfilePage />} />

        {/* Unified settings */}
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<SettingsGeneralPage />} />
          <Route path="roles"      element={<RolesPermissionsPage />} />
          <Route path="workflow"   element={<WorkflowPage />} />
          <Route path="work-policy" element={<WorkPolicyPage />} />
          <Route path="standup"    element={<StandupSettingsPage />} />
          <Route path="team-rates" element={<TeamRatesPage />} />
          <Route path="governance" element={<GovernancePoliciesPage />} />
          <Route path="audit"      element={<AuditPage />} />
          <Route path="archived-projects" element={<ArchivedProjectsPage />} />
          <Route path="integrations/github" element={<GitHubPage />} />
          <Route path="integrations/teams"  element={<TeamsPage />} />
          <Route path="integrations/microsoft-calendar" element={<MicrosoftCalendarPage />} />
          <Route path="members"    element={<MembersPage />} />
          <Route path="notifications" element={<SettingsNotificationsStub />} />
        </Route>

        {/* Legacy redirects so old links still work */}
        <Route path="/governance/policies" element={<Navigate to="/settings/governance" replace />} />
        <Route path="/governance/audit"    element={<Navigate to="/settings/audit" replace />} />
        <Route path="/integrations/github" element={<Navigate to="/settings/integrations/github" replace />} />

        <Route path="/admin/users" element={<AdminUsersPage />} />
        <Route path="/admin/audit" element={<SystemAuditPage />} />
        <Route path="/admin/daily-checkins" element={<DailyCheckinsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
